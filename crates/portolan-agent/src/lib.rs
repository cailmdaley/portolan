use portolan_agent_protocol::{
    is_safe_remote_fiber_path, AgentActivity, AgentFrame, AgentRequestPayload, AgentResultPayload,
    FiberRawOperation, FiberRawRequestPayload, FiberRawResultPayload, FiberTreeDelta,
    FiberTreeDeltaOp, FiberTreeDeltaPayload, FiberTreeDumpPayload, FiberTreeFile,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const DEFAULT_SERVER: &str = "localhost:4004";
const DEFAULT_RECONNECT_INTERVAL: Duration = Duration::from_secs(5);
const CLI_DISCOVERY_DEPTH: usize = 4;
const AGENT_SESSION_NAMES: &[&str] = &["portolan-agent", "portolan-agent-rust-preview"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPortolanActivity {
    pub tmux_session: String,
    pub tool: String,
    pub summary: Option<String>,
    pub full_path: Option<String>,
    pub timestamp: i64,
}

pub fn parse_activity_frame_from_events_jsonl_line(
    line: &str,
    fallback_timestamp_ms: i64,
) -> Option<ParsedPortolanActivity> {
    let event: Value = serde_json::from_str(line).ok()?;
    let event_type = event.get("type")?.as_str()?;
    if event_type != "pre_tool_use" && event_type != "post_tool_use" {
        return None;
    }
    let tmux_session = event.get("tmuxSession")?.as_str()?.to_string();
    if tmux_session.is_empty() {
        return None;
    }
    let tool = event.get("tool")?.as_str()?.to_string();
    let tool_input = event.get("toolInput").and_then(Value::as_object);
    let (summary, full_path) = parse_tool_activity_details(&tool, tool_input);

    Some(ParsedPortolanActivity {
        tmux_session,
        tool,
        summary,
        full_path,
        timestamp: parse_portolan_timestamp(event.get("timestamp"), fallback_timestamp_ms),
    })
}

pub fn parse_activity_frames_from_events_jsonl(
    text: &str,
    fallback_timestamp_ms: i64,
) -> Vec<AgentActivity> {
    text.split('\n')
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            parse_activity_frame_from_events_jsonl_line(line, fallback_timestamp_ms).map(
                |activity| AgentActivity {
                    tmux_session: activity.tmux_session,
                    tool: activity.tool,
                    summary: activity.summary,
                    full_path: activity.full_path,
                    timestamp: activity.timestamp,
                },
            )
        })
        .collect()
}

fn parse_portolan_timestamp(raw: Option<&Value>, fallback_timestamp_ms: i64) -> i64 {
    let Some(raw) = raw else {
        return fallback_timestamp_ms;
    };

    match raw {
        Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_u64().map(|value| value as i64))
            .unwrap_or(fallback_timestamp_ms),
        Value::String(value) => value.parse::<i64>().unwrap_or(fallback_timestamp_ms),
        _ => fallback_timestamp_ms,
    }
}

fn parse_tool_activity_details(
    tool: &str,
    tool_input: Option<&serde_json::Map<String, Value>>,
) -> (Option<String>, Option<String>) {
    if !matches!(tool, "Read" | "Write" | "Edit") {
        return (None, None);
    }

    let Some(file_path) = tool_input
        .and_then(|input| input.get("file_path"))
        .and_then(Value::as_str)
    else {
        return (None, None);
    };
    if file_path.is_empty() {
        return (None, None);
    }

    let file_path = file_path.to_string();

    let parts = file_path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.is_empty() {
        return (None, None);
    }

    let filename = parts.last().copied().unwrap_or("");
    let parent = if parts.len() >= 2 {
        Some(parts[parts.len() - 2])
    } else {
        None
    };
    let summary = Some(match parent {
        Some(parent) => {
            let display = format!("{parent}/{filename}");
            let len = display.chars().count();
            if len > 35 {
                let suffix = display
                    .chars()
                    .skip(len.saturating_sub(34))
                    .collect::<String>();
                format!("…{suffix}")
            } else {
                display
            }
        }
        None => filename.to_string(),
    });

    (summary, Some(file_path))
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct TmuxPane {
    tmux_session: String,
    cwd: String,
    pane_pid: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentCommand {
    Connect(AgentConfig),
    Status,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentConfig {
    pub server: String,
    pub origin: String,
    pub ssh_host: Option<String>,
    pub plannotator_port: Option<u16>,
    pub reconnect_interval: Duration,
    pub once: bool,
}

pub fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<AgentCommand, String> {
    let mut args = args.into_iter();
    let Some(command) = args.next().and_then(os_string_into_string) else {
        return Err(usage());
    };

    match command.as_str() {
        "connect" => parse_connect_args(args),
        "status" => Ok(AgentCommand::Status),
        "--help" | "-h" => Err(usage()),
        _ => Err(format!("unknown command `{command}`\n{}", usage())),
    }
}

fn parse_connect_args(args: impl Iterator<Item = OsString>) -> Result<AgentCommand, String> {
    let mut server = None;
    let mut origin = None;
    let mut ssh_host = None;
    let mut plannotator_port = None;
    let mut once = false;
    let mut pending = args.peekable();

    while let Some(arg) = pending.next().and_then(os_string_into_string) {
        if arg == "--once" {
            once = true;
        } else if arg == "--help" || arg == "-h" {
            return Err(usage());
        } else if arg == "--ssh-host" {
            ssh_host = Some(next_value(&mut pending, "--ssh-host")?);
        } else if let Some(value) = arg.strip_prefix("--ssh-host=") {
            ssh_host = Some(non_empty(value, "--ssh-host")?);
        } else if arg == "--origin" {
            origin = Some(next_value(&mut pending, "--origin")?);
        } else if let Some(value) = arg.strip_prefix("--origin=") {
            origin = Some(non_empty(value, "--origin")?);
        } else if arg == "--plannotator-port" {
            plannotator_port = Some(parse_port(&next_value(
                &mut pending,
                "--plannotator-port",
            )?)?);
        } else if let Some(value) = arg.strip_prefix("--plannotator-port=") {
            plannotator_port = Some(parse_port(&non_empty(value, "--plannotator-port")?)?);
        } else if arg.starts_with('-') {
            return Err(format!("unknown option `{arg}`\n{}", usage()));
        } else if server.is_none() {
            server = Some(arg);
        } else {
            return Err(format!("unexpected argument `{arg}`\n{}", usage()));
        }
    }

    Ok(AgentCommand::Connect(AgentConfig {
        server: server.unwrap_or_else(|| DEFAULT_SERVER.to_string()),
        origin: origin.unwrap_or_else(default_origin),
        ssh_host,
        plannotator_port,
        reconnect_interval: DEFAULT_RECONNECT_INTERVAL,
        once,
    }))
}

fn next_value(args: &mut impl Iterator<Item = OsString>, flag: &str) -> Result<String, String> {
    args.next()
        .and_then(os_string_into_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing value for {flag}\n{}", usage()))
}

fn non_empty(value: &str, flag: &str) -> Result<String, String> {
    if value.is_empty() {
        Err(format!("missing value for {flag}\n{}", usage()))
    } else {
        Ok(value.to_string())
    }
}

fn parse_port(value: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .map_err(|_| format!("invalid --plannotator-port `{value}`"))
}

fn os_string_into_string(value: OsString) -> Option<String> {
    value.into_string().ok()
}

fn default_origin() -> String {
    env::var("PORTOLAN_ORIGIN")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            hostname::get()
                .ok()
                .and_then(|host| host.into_string().ok())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "unknown".to_string())
        })
}

pub fn build_agent_url(config: &AgentConfig) -> String {
    let mut url = if config.server.starts_with("ws://") || config.server.starts_with("wss://") {
        config.server.clone()
    } else {
        format!("ws://{}", config.server)
    };
    if !url.contains('?') && !url[url.find("://").map_or(0, |idx| idx + 3)..].contains('/') {
        url.push('/');
    }

    let separator = if url.contains('?') { '&' } else { '?' };
    url.push(separator);
    url.push_str("agent=true&origin=");
    url.push_str(&urlencoding::encode(&config.origin));

    if let Some(ssh_host) = effective_ssh_host(config) {
        url.push_str("&sshHost=");
        url.push_str(&urlencoding::encode(&ssh_host));
    }
    if let Some(plannotator_port) = config.plannotator_port {
        url.push_str("&plannotatorPort=");
        url.push_str(&plannotator_port.to_string());
    }

    url
}

fn effective_ssh_host(config: &AgentConfig) -> Option<String> {
    let base = config.ssh_host.as_ref()?.trim();
    if base.is_empty() {
        return None;
    }

    let Some(login_node) = login_node_from_origin(&config.origin) else {
        return Some(base.to_string());
    };
    if base.ends_with(&format!("-{login_node}")) {
        Some(base.to_string())
    } else {
        Some(format!("{base}-{login_node}"))
    }
}

fn login_node_from_origin(origin: &str) -> Option<&str> {
    let first = origin.split('.').next()?;
    let suffix = first.strip_prefix("login")?;
    if !suffix.is_empty() && suffix.chars().all(|ch| ch.is_ascii_digit()) {
        Some(first)
    } else {
        None
    }
}

pub fn handle_server_frame(frame: &AgentFrame) -> Vec<AgentFrame> {
    match frame {
        AgentFrame::Connected { payload } => {
            eprintln!(
                "[portolan-agent-rust] registered as {} at ({}, {})",
                payload.origin_id, payload.position.q, payload.position.r
            );
            Vec::new()
        }
        AgentFrame::FiberTreeHosts { payload } => build_fiber_tree_dumps(&payload.felt_hosts),
        AgentFrame::KanbanTransition { payload } => {
            vec![handle_kanban_transition(payload)]
        }
        AgentFrame::FiberRaw { payload } => vec![handle_fiber_raw(payload)],
        _ => Vec::new(),
    }
}

pub fn collect_agent_sessions() -> Vec<portolan_agent_protocol::AgentSession> {
    collect_agent_sessions_with_runner(run_command_for_discovery)
}

fn collect_agent_sessions_with_runner(
    mut run_command: impl FnMut(&str, &[&str]) -> Result<String, String>,
) -> Vec<portolan_agent_protocol::AgentSession> {
    let output = match run_command(
        "tmux",
        &[
            "list-panes",
            "-a",
            "-F",
            "#{session_name}\t#{pane_current_path}\t#{pane_pid}",
        ],
    ) {
        Ok(output) => output,
        Err(error) => {
            eprintln!("[portolan-agent-rust] session discovery failed: {error}");
            return Vec::new();
        }
    };

    let panes = parse_tmux_panes(&output);
    let mut sessions = Vec::new();
    for pane in panes {
        let cwd = pane.cwd.clone();
        if !is_cli_tmux_pane(&pane.pane_pid, &mut run_command) {
            continue;
        }
        let has_claims = detect_claims_in_cwd(&cwd);
        let has_playgrounds = detect_playgrounds_in_cwd(&cwd);
        let git_status = collect_git_status_for_cwd(&cwd, &mut run_command);
        sessions.push(portolan_agent_protocol::AgentSession {
            id: None,
            name: pane.tmux_session.clone(),
            tmux_session: pane.tmux_session,
            cwd,
            status: Some(portolan_agent_protocol::AgentSessionStatus::Idle),
            has_claims: Some(has_claims),
            has_playgrounds: Some(has_playgrounds),
            git_status,
        });
    }
    sessions
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitFileCounts {
    added: u64,
    modified: u64,
    deleted: u64,
}

impl GitFileCounts {
    fn new() -> Self {
        Self {
            added: 0,
            modified: 0,
            deleted: 0,
        }
    }

    fn total(&self) -> u64 {
        self.added + self.modified + self.deleted
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedGitPorcelain {
    staged: GitFileCounts,
    unstaged: GitFileCounts,
    untracked: u64,
}

fn parse_git_porcelain(raw: &str) -> ParsedGitPorcelain {
    let mut staged = GitFileCounts::new();
    let mut unstaged = GitFileCounts::new();
    let mut untracked = 0u64;

    for line in raw.lines() {
        if line.len() < 2 {
            continue;
        }
        let staged_mark = line.as_bytes()[0] as char;
        let unstaged_mark = line.as_bytes()[1] as char;

        match staged_mark {
            'A' => staged.added += 1,
            'M' => staged.modified += 1,
            'D' => staged.deleted += 1,
            _ => {}
        }

        match unstaged_mark {
            'A' => unstaged.added += 1,
            'M' => unstaged.modified += 1,
            'D' => unstaged.deleted += 1,
            _ => {}
        }

        if staged_mark == '?' && unstaged_mark == '?' {
            untracked += 1;
        }
    }

    ParsedGitPorcelain {
        staged,
        unstaged,
        untracked,
    }
}

fn parse_git_shortstat(raw: &str) -> (u64, u64) {
    let mut added = 0u64;
    let mut removed = 0u64;
    let words = raw.split_whitespace().collect::<Vec<_>>();

    for (index, word) in words.iter().enumerate() {
        let Ok(value) = word.parse::<u64>() else {
            continue;
        };
        let Some(label) = words.get(index + 1) else {
            continue;
        };

        let token = label
            .trim_start_matches(|c: char| !c.is_ascii_alphabetic())
            .trim_end_matches(|c: char| !c.is_ascii_alphabetic())
            .to_ascii_lowercase();

        if token.starts_with("insertion") {
            added = value;
        } else if token.starts_with("deletion") {
            removed = value;
        }
    }

    (added, removed)
}

fn collect_git_status_for_cwd(
    cwd: &str,
    run_command: &mut impl FnMut(&str, &[&str]) -> Result<String, String>,
) -> Option<Value> {
    let in_repo = match run_command("git", &["-C", cwd, "rev-parse", "--is-inside-work-tree"]) {
        Ok(result) => result.trim() == "true",
        Err(_) => return None,
    };
    if !in_repo {
        return None;
    }

    let branch = match run_command("git", &["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]) {
        Ok(output) => output.trim().to_string(),
        Err(_) => String::new(),
    };

    let porcelain = run_command("git", &["-C", cwd, "status", "--porcelain"]).unwrap_or_default();
    let parsed = parse_git_porcelain(&porcelain);
    let (ahead, behind) = match run_command(
        "git",
        &[
            "-C",
            cwd,
            "rev-list",
            "--left-right",
            "--count",
            "@{upstream}...HEAD",
        ],
    ) {
        Ok(output) => {
            let mut split = output.split_whitespace();
            let behind = split.next().and_then(|value| value.parse::<u64>().ok());
            let ahead = split.next().and_then(|value| value.parse::<u64>().ok());
            (ahead.unwrap_or(0), behind.unwrap_or(0))
        }
        Err(_) => (0, 0),
    };

    let (staged_added, staged_removed) =
        match run_command("git", &["-C", cwd, "diff", "--cached", "--shortstat"]) {
            Ok(output) => parse_git_shortstat(&output),
            Err(_) => (0, 0),
        };
    let (unstaged_added, unstaged_removed) =
        match run_command("git", &["-C", cwd, "diff", "--shortstat"]) {
            Ok(output) => parse_git_shortstat(&output),
            Err(_) => (0, 0),
        };

    let (last_commit_time, last_commit_message) =
        match run_command("git", &["-C", cwd, "log", "-1", "--format=%ct|||%s"]) {
            Ok(output) => {
                let mut split = output.trim().splitn(2, "|||");
                let time = split
                    .next()
                    .and_then(|value| value.trim().parse::<i64>().ok());
                let message = split
                    .next()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(|value| value.to_string());
                (time, message)
            }
            Err(_) => (None, None),
        };

    let dirty = parsed.staged.total() > 0 || parsed.unstaged.total() > 0 || parsed.untracked > 0;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as i64)
        .unwrap_or(0);

    Some(json!({
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "dirty": dirty,
        "staged": {
            "added": parsed.staged.added,
            "modified": parsed.staged.modified,
            "deleted": parsed.staged.deleted,
        },
        "unstaged": {
            "added": parsed.unstaged.added,
            "modified": parsed.unstaged.modified,
            "deleted": parsed.unstaged.deleted,
        },
        "untracked": parsed.untracked,
        "totalFiles": parsed.staged.total() + parsed.unstaged.total() + parsed.untracked,
        "linesAdded": staged_added + unstaged_added,
        "linesRemoved": staged_removed + unstaged_removed,
        "lastCommitTime": last_commit_time.map_or(Value::Null, Value::from),
        "lastCommitMessage": last_commit_message.map_or(Value::Null, Value::from),
        "isRepo": true,
        "lastChecked": now,
    }))
}

fn parse_tmux_panes(raw: &str) -> Vec<TmuxPane> {
    let fallback_cwd = env::current_dir()
        .ok()
        .map(|dir| dir.display().to_string())
        .unwrap_or_else(|| ".".to_string());

    raw.lines()
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| {
            let mut parts = line.split('\t');
            let tmux_session = parts.next()?.trim();
            if tmux_session.is_empty() || is_self_session_name(tmux_session) {
                return None;
            }
            let cwd = parts
                .next()
                .filter(|cwd| !cwd.trim().is_empty())
                .unwrap_or(&fallback_cwd);
            let pane_pid = parts.next().filter(|pid| !pid.trim().is_empty())?;
            Some(TmuxPane {
                tmux_session: tmux_session.to_string(),
                cwd: cwd.to_string(),
                pane_pid: pane_pid.trim().to_string(),
            })
        })
        .collect()
}

fn is_self_session_name(tmux_session: &str) -> bool {
    AGENT_SESSION_NAMES
        .iter()
        .any(|name| tmux_session == *name || tmux_session.starts_with(&format!("{name}-")))
}

fn is_cli_tmux_pane(
    pane_pid: &str,
    run_command: &mut impl FnMut(&str, &[&str]) -> Result<String, String>,
) -> bool {
    let mut frontier = vec![pane_pid.to_string()];
    for _ in 0..CLI_DISCOVERY_DEPTH {
        if frontier.is_empty() {
            return false;
        }
        let mut next_frontier = Vec::new();
        let mut found = false;

        for pid in frontier.drain(..) {
            if is_cli_process_in_pid_tree(pid.as_str(), run_command) {
                found = true;
                break;
            }

            if let Ok(child_pids) = run_command("pgrep", &["-P", pid.as_str()]) {
                for child_pid in parse_pids(child_pids) {
                    next_frontier.push(child_pid);
                }
            }
        }

        if found {
            return true;
        }
        frontier = next_frontier;
    }
    false
}

fn is_cli_process_in_pid_tree(
    pid: &str,
    run_command: &mut impl FnMut(&str, &[&str]) -> Result<String, String>,
) -> bool {
    match run_command("ps", &["-o", "comm=", "-p", pid]) {
        Ok(comm) if is_cli_process(&comm) => return true,
        Ok(_) => {}
        Err(_) => return false,
    }

    matches!(
        run_command("ps", &["-o", "args=", "-p", pid]),
        Ok(args) if is_cli_process(&args)
    )
}

fn is_cli_process(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    lowered.contains("claude") || lowered.contains("codex") || lowered.contains("pi")
}

fn parse_pids(raw: String) -> Vec<String> {
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| line.to_string())
        .collect()
}

fn detect_claims_in_cwd(cwd: &str) -> bool {
    let root = Path::new(cwd);
    root.join("workflow").join("config").exists()
        || root.join("results").join("tapestry").exists()
        || root.join(".felt").exists()
}

fn detect_playgrounds_in_cwd(cwd: &str) -> bool {
    let playground_dir = Path::new(cwd).join(".portolan/playgrounds");
    let entries = match fs::read_dir(playground_dir) {
        Ok(entries) => entries,
        Err(_) => return false,
    };
    for entry in entries.flatten() {
        if let Some(ext) = entry.path().extension().and_then(|value| value.to_str()) {
            if ext == "html" {
                return true;
            }
        }
    }
    false
}

fn run_command_for_discovery(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| format!("{program} command failed: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} command failed with status {}",
            output.status
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FiberTreeFileOp {
    Upsert,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FiberTreeFileEvent {
    pub felt_host: String,
    pub path: String,
    pub op: FiberTreeFileOp,
}

fn handle_kanban_transition(payload: &AgentRequestPayload) -> AgentFrame {
    match run_kanban_transition(payload) {
        Ok(fiber) => AgentFrame::KanbanTransitionResult {
            payload: AgentResultPayload {
                correlation_id: payload.correlation_id.clone(),
                ok: true,
                error: None,
                fiber: Some(fiber),
                fields: Default::default(),
            },
        },
        Err(error) => AgentFrame::KanbanTransitionResult {
            payload: AgentResultPayload {
                correlation_id: payload.correlation_id.clone(),
                ok: false,
                error: Some(error),
                fiber: None,
                fields: Default::default(),
            },
        },
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessInvocation {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    envs: BTreeMap<String, String>,
}

fn run_kanban_transition(payload: &AgentRequestPayload) -> Result<Value, String> {
    run_kanban_transition_with(payload, run_process, read_felt_fiber_json)
}

fn run_kanban_transition_with<R, S>(
    payload: &AgentRequestPayload,
    mut run_process: R,
    read_snapshot: S,
) -> Result<Value, String>
where
    R: FnMut(ProcessInvocation) -> Result<(), String>,
    S: Fn(&str, &str) -> Result<Value, String>,
{
    let rel_path = required_string_field(payload, "path")?;
    let felt_host = optional_string_field(payload, "feltHost")
        .map(str::to_string)
        .unwrap_or_else(default_felt_host);
    let full_path = resolve_remote_fiber_file(&felt_host, rel_path)?;

    run_kanban_mutation_with(
        payload,
        &full_path,
        &felt_host,
        &mut run_process,
        &read_snapshot,
    )?;

    let fiber_id =
        fiber_id_from_path(rel_path).ok_or_else(|| format!("path is not a fiber: {rel_path}"))?;
    read_snapshot(&felt_host, &fiber_id)
        .map_err(|error| format!("felt show failed after mutation: {fiber_id}: {error}"))
}

fn run_kanban_mutation_with<R, S>(
    payload: &AgentRequestPayload,
    full_path: &Path,
    felt_host: &str,
    run_process: &mut R,
    read_snapshot: &S,
) -> Result<(), String>
where
    R: FnMut(ProcessInvocation) -> Result<(), String>,
    S: Fn(&str, &str) -> Result<Value, String>,
{
    match required_string_field(payload, "kind")? {
        "shuttle" => run_shuttle_kanban_mutation(payload, felt_host, run_process),
        "felt-tags" => {
            run_felt_tags_kanban_mutation(payload, felt_host, run_process, read_snapshot)
        }
        "felt-horizon" => run_felt_horizon_kanban_mutation(payload, full_path),
        kind => Err(format!("unknown mutation kind: {kind}")),
    }
}

fn run_shuttle_kanban_mutation<R>(
    payload: &AgentRequestPayload,
    felt_host: &str,
    run_process: &mut R,
) -> Result<(), String>
where
    R: FnMut(ProcessInvocation) -> Result<(), String>,
{
    let verb = required_string_field(payload, "verb")?;
    let fiber_id = required_string_field(payload, "fiberId")?;
    let mut args = vec![
        "--felt-store".to_string(),
        felt_host.to_string(),
        verb.to_string(),
        fiber_id.to_string(),
    ];

    match verb {
        "pause" | "reopen" | "accept" | "resume" => {}
        "close" => {
            if let Some(tempered) = optional_bool_field(payload, "tempered")? {
                args.push(format!(
                    "--tempered={}",
                    if tempered { "true" } else { "false" }
                ));
            }
        }
        "set-outcome" => {
            let outcome = required_string_field(payload, "outcome")?;
            args.push("--outcome".to_string());
            args.push(outcome.to_string());
        }
        "dispatch" => {
            if optional_bool_field(payload, "adHoc")?.unwrap_or(false) {
                args.push("--ad-hoc".to_string());
            }
        }
        _ => return Err(format!("unknown shuttle verb: {verb}")),
    }

    run_process(ProcessInvocation {
        program: "shuttle-ctl".to_string(),
        args,
        cwd: normalize_host_path(felt_host),
        envs: process_env_for_felt_host(felt_host),
    })
}

fn run_felt_tags_kanban_mutation<R, S>(
    payload: &AgentRequestPayload,
    felt_host: &str,
    run_process: &mut R,
    read_snapshot: &S,
) -> Result<(), String>
where
    R: FnMut(ProcessInvocation) -> Result<(), String>,
    S: Fn(&str, &str) -> Result<Value, String>,
{
    let fiber_id = required_string_field(payload, "fiberId")?;
    let tags = payload
        .fields
        .get("tags")
        .and_then(Value::as_array)
        .ok_or_else(|| "missing tags payload".to_string())?;
    let next = normalize_tag_list(tags.iter().filter_map(Value::as_str));
    let current_fiber = read_snapshot(felt_host, fiber_id)?;
    let current = normalize_tag_list(
        current_fiber
            .get("tags")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str),
    );
    let (add, remove) = diff_tag_lists(&current, &next);
    if add.is_empty() && remove.is_empty() {
        return Ok(());
    }

    let mut args = vec![
        "-C".to_string(),
        felt_host.to_string(),
        "edit".to_string(),
        fiber_id.to_string(),
    ];
    for tag in remove {
        args.push("--untag".to_string());
        args.push(tag);
    }
    for tag in add {
        args.push("--tag".to_string());
        args.push(tag);
    }

    run_process(ProcessInvocation {
        program: "felt".to_string(),
        args,
        cwd: normalize_host_path(felt_host),
        envs: process_env_for_felt_host(felt_host),
    })
}

fn run_felt_horizon_kanban_mutation(
    payload: &AgentRequestPayload,
    full_path: &Path,
) -> Result<(), String> {
    let horizon = match payload.fields.get("horizon") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.as_str()),
        Some(other) => {
            return Err(format!(
                "invalid horizon payload: expected string or null, got {other}"
            ))
        }
        None => return Err("missing horizon payload".to_string()),
    };
    let cold = optional_bool_field(payload, "cold")?;
    // due: missing → Keep; null → Clear; string → Set(value).
    let due = match payload.fields.get("due") {
        None => DueOp::Keep,
        Some(Value::Null) => DueOp::Clear,
        Some(Value::String(value)) => DueOp::Set(value.clone()),
        Some(other) => {
            return Err(format!(
                "invalid due payload: expected string or null, got {other}"
            ))
        }
    };
    let raw = fs::read_to_string(full_path)
        .map_err(|error| format!("failed to read fiber {}: {error}", full_path.display()))?;
    let rewritten = rewrite_horizon_frontmatter(&raw, horizon, cold, due)?;
    fs::write(full_path, rewritten)
        .map_err(|error| format!("failed to write fiber {}: {error}", full_path.display()))
}

#[derive(Debug, Clone)]
enum DueOp {
    Keep,
    Clear,
    Set(String),
}

fn run_process(invocation: ProcessInvocation) -> Result<(), String> {
    let mut child = Command::new(&invocation.program)
        .args(&invocation.args)
        .current_dir(&invocation.cwd)
        .envs(&invocation.envs)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("failed to run {}: {error}", invocation.program))?;

    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to wait for {}: {error}", invocation.program))?
        {
            break status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{} {} timed out after 10s",
                invocation.program,
                invocation.args.join(" ")
            ));
        }
        thread::sleep(Duration::from_millis(20));
    };

    let mut stderr = String::new();
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }
    if status.success() {
        Ok(())
    } else if stderr.trim().is_empty() {
        Err(format!(
            "{} {} failed with status {status}",
            invocation.program,
            invocation.args.join(" ")
        ))
    } else {
        Err(format!(
            "{} {} failed: {}",
            invocation.program,
            invocation.args.join(" "),
            stderr.trim()
        ))
    }
}

fn process_env_for_felt_host(felt_host: &str) -> BTreeMap<String, String> {
    let mut envs = BTreeMap::new();
    envs.insert("LOOM_HOME".to_string(), felt_host.to_string());
    if let Ok(home) = env::var("HOME") {
        envs.insert("HOME".to_string(), home);
    }
    envs
}

fn required_string_field<'a>(
    payload: &'a AgentRequestPayload,
    key: &str,
) -> Result<&'a str, String> {
    optional_string_field(payload, key).ok_or_else(|| format!("missing {key}"))
}

fn optional_string_field<'a>(payload: &'a AgentRequestPayload, key: &str) -> Option<&'a str> {
    payload.fields.get(key).and_then(Value::as_str)
}

fn optional_bool_field(payload: &AgentRequestPayload, key: &str) -> Result<Option<bool>, String> {
    match payload.fields.get(key) {
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(_) => Err(format!("invalid {key}: expected boolean")),
        None => Ok(None),
    }
}

fn normalize_tag_list<'a>(tags: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = BTreeMap::<String, ()>::new();
    let mut out = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() || seen.contains_key(trimmed) {
            continue;
        }
        seen.insert(trimmed.to_string(), ());
        out.push(trimmed.to_string());
    }
    out
}

fn diff_tag_lists(current: &[String], next: &[String]) -> (Vec<String>, Vec<String>) {
    let add = next
        .iter()
        .filter(|tag| !current.contains(tag))
        .cloned()
        .collect();
    let remove = current
        .iter()
        .filter(|tag| !next.contains(tag))
        .cloned()
        .collect();
    (add, remove)
}

fn rewrite_horizon_frontmatter(
    raw: &str,
    horizon: Option<&str>,
    cold: Option<bool>,
    due: DueOp,
) -> Result<String, String> {
    if let Some(horizon) = horizon {
        if !matches!(horizon, "now" | "soon" | "stashed") {
            return Err(format!("unknown horizon: {horizon}"));
        }
    }

    let (frontmatter, closing_newline_len, body_start) = split_yaml_frontmatter(raw)?;
    let parsed: serde_yaml::Value = serde_yaml::from_str(frontmatter)
        .map_err(|error| format!("failed to parse fiber frontmatter: {error}"))?;
    if !matches!(
        parsed,
        serde_yaml::Value::Mapping(_) | serde_yaml::Value::Null
    ) {
        return Err("fiber frontmatter must be a YAML mapping".to_string());
    }

    let eol = if raw.contains("\r\n") { "\r\n" } else { "\n" };
    let mut lines: Vec<String> = if frontmatter.is_empty() {
        Vec::new()
    } else {
        frontmatter
            .split('\n')
            .map(|line| line.strip_suffix('\r').unwrap_or(line).to_string())
            .collect()
    };

    // Edit `horizon:` first, then resolve `cold:` and `due:`.
    edit_top_level_key(
        &mut lines,
        "horizon",
        horizon.map(|h| format!("horizon: {h}")),
    );

    let (touch_cold, next_cold_line) = match (horizon, cold) {
        (None, _) => (true, None),
        (Some("stashed"), Some(true)) => (true, Some("cold: true".to_string())),
        (Some("stashed"), Some(false)) => (true, None),
        (Some("stashed"), None) => (false, None),
        (Some(_), _) => (true, None),
    };
    if touch_cold {
        edit_top_level_key(&mut lines, "cold", next_cold_line);
    }

    match due {
        DueOp::Keep => {}
        DueOp::Clear => edit_top_level_key(&mut lines, "due", None),
        DueOp::Set(value) => edit_top_level_key(&mut lines, "due", Some(format!("due: {value}"))),
    }

    let closing_newline = &raw[body_start - closing_newline_len..body_start];
    let body = &raw[body_start..];
    Ok(format!(
        "---{eol}{}{eol}---{closing_newline}{body}",
        lines.join(eol)
    ))
}

/// In-place top-level key edit: when `replacement` is `Some`, replace
/// the key's range (or push at end if absent); when `None`, splice the
/// existing range out entirely.
fn edit_top_level_key(lines: &mut Vec<String>, key: &str, replacement: Option<String>) {
    let range = top_level_key_range(lines, key);
    match (replacement, range) {
        (None, Some((start, end))) => {
            lines.splice(start..end, std::iter::empty());
        }
        (None, None) => {}
        (Some(line), Some((start, end))) => {
            lines.splice(start..end, [line]);
        }
        (Some(line), None) => lines.push(line),
    }
}

fn split_yaml_frontmatter(raw: &str) -> Result<(&str, usize, usize), String> {
    let Some(after_open) = raw
        .strip_prefix("---\n")
        .map(|_| 4)
        .or_else(|| raw.strip_prefix("---\r\n").map(|_| 5))
    else {
        return Err("fiber file has no YAML frontmatter".to_string());
    };
    let rest = &raw[after_open..];
    for marker in ["\n---\r\n", "\n---\n", "\r\n---\r\n", "\r\n---\n"] {
        if let Some(idx) = rest.find(marker) {
            let marker_start = after_open + idx;
            let frontmatter = &raw[after_open..marker_start];
            let closing_newline_len = if marker.ends_with("\r\n") { 2 } else { 1 };
            let body_start = marker_start + marker.len();
            return Ok((frontmatter, closing_newline_len, body_start));
        }
    }
    Err("fiber file has no YAML frontmatter".to_string())
}

fn top_level_key_range(lines: &[String], key: &str) -> Option<(usize, usize)> {
    let start = lines
        .iter()
        .position(|line| is_named_top_level_key(line, key))?;
    let mut end = start + 1;
    while end < lines.len() && !is_any_top_level_key(&lines[end]) {
        end += 1;
    }
    Some((start, end))
}

fn is_named_top_level_key(line: &str, key: &str) -> bool {
    let Some(rest) = line.strip_prefix(key) else {
        return false;
    };
    rest.trim_start().starts_with(':')
}

fn is_any_top_level_key(line: &str) -> bool {
    let Some((key, _)) = line.split_once(':') else {
        return false;
    };
    !key.is_empty()
        && key
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
}

fn handle_fiber_raw(payload: &FiberRawRequestPayload) -> AgentFrame {
    let result = match payload.operation {
        FiberRawOperation::Read => {
            read_raw_fiber(payload).map(|(body, sha256)| RawFiberResult::Read { body, sha256 })
        }
        FiberRawOperation::Write => {
            write_raw_fiber(payload).map(|(sha256, fiber)| RawFiberResult::Write { sha256, fiber })
        }
    };

    match result {
        Ok(RawFiberResult::Read { body, sha256 }) => AgentFrame::FiberRawResult {
            payload: FiberRawResultPayload {
                correlation_id: payload.correlation_id.clone(),
                ok: true,
                error: None,
                body: Some(body),
                sha256: Some(sha256),
                fiber: None,
            },
        },
        Ok(RawFiberResult::Write { sha256, fiber }) => AgentFrame::FiberRawResult {
            payload: FiberRawResultPayload {
                correlation_id: payload.correlation_id.clone(),
                ok: true,
                error: None,
                body: None,
                sha256: Some(sha256),
                fiber: Some(fiber),
            },
        },
        Err(error) => AgentFrame::FiberRawResult {
            payload: FiberRawResultPayload {
                correlation_id: payload.correlation_id.clone(),
                ok: false,
                error: Some(error),
                body: None,
                sha256: None,
                fiber: None,
            },
        },
    }
}

enum RawFiberResult {
    Read { body: String, sha256: String },
    Write { sha256: String, fiber: Value },
}

fn read_raw_fiber(payload: &FiberRawRequestPayload) -> Result<(String, String), String> {
    let felt_host = payload.felt_host.clone().unwrap_or_else(default_felt_host);
    let full_path = resolve_remote_fiber_file(&felt_host, &payload.path)?;
    let body = fs::read_to_string(&full_path)
        .map_err(|error| format!("failed to read fiber {}: {error}", payload.path))?;
    let sha256 = sha256_hex(&body);
    Ok((body, sha256))
}

fn write_raw_fiber(payload: &FiberRawRequestPayload) -> Result<(String, Value), String> {
    write_raw_fiber_with_snapshot(payload, read_felt_fiber_json)
}

fn write_raw_fiber_with_snapshot(
    payload: &FiberRawRequestPayload,
    read_snapshot: impl Fn(&str, &str) -> Result<Value, String>,
) -> Result<(String, Value), String> {
    let body = payload
        .body
        .as_deref()
        .ok_or_else(|| "missing body".to_string())?;
    if body.len() > 2_000_000 {
        return Err("fiber body exceeds 2 MB".to_string());
    }

    let felt_host = payload.felt_host.clone().unwrap_or_else(default_felt_host);
    let full_path = resolve_remote_fiber_file(&felt_host, &payload.path)?;
    write_atomic(&full_path, body)?;
    let fiber_id = fiber_id_from_path(&payload.path)
        .ok_or_else(|| format!("path is not a fiber: {}", payload.path))?;
    let fiber = read_snapshot(&felt_host, &fiber_id)
        .map_err(|error| format!("felt show failed after raw write: {fiber_id}: {error}"))?;
    Ok((sha256_hex(body), fiber))
}

fn read_felt_fiber_json(felt_host: &str, fiber_id: &str) -> Result<Value, String> {
    let output = Command::new("felt")
        .args(["-C", felt_host, "show", fiber_id, "-j"])
        .output()
        .map_err(|error| format!("failed to run felt: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("failed to parse felt JSON: {error}"))?;
    if !parsed.is_object() {
        return Err("felt JSON was not an object".to_string());
    }
    Ok(parsed)
}

fn write_atomic(target: &Path, content: &str) -> Result<(), String> {
    let parent = target
        .parent()
        .ok_or_else(|| format!("target has no parent: {}", target.display()))?;
    let file_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| format!("target has no UTF-8 filename: {}", target.display()))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("system clock before UNIX epoch: {error}"))?
        .as_nanos();
    let tmp = parent.join(format!(".{file_name}.{}.{}.tmp", std::process::id(), nonce));
    fs::write(&tmp, content)
        .map_err(|error| format!("failed to write temporary fiber {}: {error}", tmp.display()))?;
    fs::rename(&tmp, target).map_err(|error| {
        let _ = fs::remove_file(&tmp);
        format!("failed to replace fiber {}: {error}", target.display())
    })
}

fn build_fiber_tree_dumps(felt_hosts: &[String]) -> Vec<AgentFrame> {
    let mut frames = Vec::new();
    let mut seen = Vec::<PathBuf>::new();

    for felt_host in felt_hosts.iter().filter(|host| !host.trim().is_empty()) {
        let normalized_host = normalize_host_path(felt_host);
        if seen.iter().any(|host| host == &normalized_host) {
            continue;
        }
        seen.push(normalized_host.clone());

        match collect_fiber_tree_files(&normalized_host) {
            Ok(files) => {
                eprintln!(
                    "[portolan-agent-rust] publishing fiber_tree_dump: {} fibers from {}",
                    files.len(),
                    normalized_host.display()
                );
                frames.push(AgentFrame::FiberTreeDump {
                    payload: FiberTreeDumpPayload {
                        felt_host: normalized_host.display().to_string(),
                        files,
                    },
                });
            }
            Err(error) => {
                eprintln!(
                    "[portolan-agent-rust] fiber-tree dump skipped for {}: {error}",
                    normalized_host.display()
                );
            }
        }
    }

    frames
}

pub fn collect_fiber_tree_delta_frame(
    felt_host: &str,
    pending: &BTreeMap<String, FiberTreeFileOp>,
) -> Option<AgentFrame> {
    collect_fiber_tree_delta_frame_with_snapshot(felt_host, pending, read_felt_fiber_json)
}

fn collect_fiber_tree_delta_frame_with_snapshot(
    felt_host: &str,
    pending: &BTreeMap<String, FiberTreeFileOp>,
    read_snapshot: impl Fn(&str, &str) -> Result<Value, String>,
) -> Option<AgentFrame> {
    let normalized_host = normalize_felt_host(felt_host);
    let felt_dir = Path::new(&normalized_host).join(".felt");
    let mut deltas = Vec::new();

    for (path, op) in pending {
        match op {
            FiberTreeFileOp::Delete => deltas.push(FiberTreeDelta {
                path: path.clone(),
                op: FiberTreeDeltaOp::Delete,
                fiber: None,
                content: None,
            }),
            FiberTreeFileOp::Upsert => {
                let full_path = felt_dir.join(path);
                if !full_path.exists() {
                    deltas.push(FiberTreeDelta {
                        path: path.clone(),
                        op: FiberTreeDeltaOp::Delete,
                        fiber: None,
                        content: None,
                    });
                    continue;
                }
                let Some(fiber_id) = fiber_id_from_path(path) else {
                    continue;
                };
                if let Ok(fiber) = read_snapshot(&normalized_host, &fiber_id) {
                    deltas.push(FiberTreeDelta {
                        path: path.clone(),
                        op: FiberTreeDeltaOp::Upsert,
                        fiber: Some(fiber),
                        content: None,
                    });
                }
            }
        }
    }

    if deltas.is_empty() {
        None
    } else {
        Some(AgentFrame::FiberTreeDelta {
            payload: FiberTreeDeltaPayload {
                felt_host: Some(normalized_host),
                deltas,
            },
        })
    }
}

fn collect_fiber_tree_files(felt_host: &Path) -> Result<Vec<FiberTreeFile>, String> {
    collect_fiber_tree_files_with_index(felt_host, read_felt_index_json)
}

fn collect_fiber_tree_files_with_index(
    felt_host: &Path,
    read_index: impl Fn(&Path) -> BTreeMap<String, Value>,
) -> Result<Vec<FiberTreeFile>, String> {
    let felt_dir = felt_host.join(".felt");
    if !felt_dir.is_dir() {
        return Err(format!("{} does not exist", felt_dir.display()));
    }
    let indexed = read_index(felt_host);

    let mut paths = Vec::new();
    collect_fiber_paths(&felt_dir, &felt_dir, &mut paths);
    paths.sort();

    let mut files = Vec::new();
    for path in paths {
        let Some(fiber_id) = fiber_id_from_path(&path) else {
            continue;
        };
        if let Some(fiber) = indexed.get(&fiber_id) {
            files.push(FiberTreeFile {
                path,
                fiber: Some(fiber.clone()),
                content: None,
            });
            continue;
        }

        let body = fs::read_to_string(felt_dir.join(&path))
            .map_err(|error| format!("failed to read {path}: {error}"))?;
        files.push(FiberTreeFile {
            path,
            fiber: None,
            content: Some(body),
        });
    }
    Ok(files)
}

fn read_felt_index_json(felt_host: &Path) -> BTreeMap<String, Value> {
    if !felt_host.join(".felt/index.db").is_file() {
        return BTreeMap::new();
    }

    let output = match Command::new("felt")
        .args([
            "-C",
            felt_host.to_string_lossy().as_ref(),
            "ls",
            "-s",
            "all",
            "-j",
            "--body",
        ])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return BTreeMap::new(),
    };

    let parsed: Value = match serde_json::from_slice(&output.stdout) {
        Ok(parsed) => parsed,
        Err(_) => return BTreeMap::new(),
    };

    let Some(fibers) = parsed.as_array() else {
        return BTreeMap::new();
    };

    fibers
        .iter()
        .filter_map(|fiber| {
            let id = fiber.get("id")?.as_str()?;
            Some((id.to_string(), fiber.clone()))
        })
        .collect()
}

fn collect_fiber_paths(root: &Path, current: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            collect_fiber_paths(root, &path, out);
        } else if file_type.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md")
        {
            let Ok(rel_path) = path.strip_prefix(root) else {
                continue;
            };
            let rel_path = rel_path
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            if fiber_id_from_path(&rel_path).is_some() {
                out.push(rel_path);
            }
        }
    }
}

fn resolve_remote_fiber_file(felt_host: &str, rel_path: &str) -> Result<PathBuf, String> {
    if !is_safe_remote_fiber_path(rel_path) {
        return Err(format!("invalid path: {rel_path}"));
    }
    if fiber_id_from_path(rel_path).is_none() {
        return Err(format!("path is not a fiber: {rel_path}"));
    }

    let felt_dir = normalize_host_path(felt_host).join(".felt");
    let full_path = felt_dir.join(rel_path);
    if !full_path.starts_with(&felt_dir) {
        return Err(format!("path escapes .felt: {rel_path}"));
    }
    if !full_path.exists() {
        return Err(format!("fiber file missing: {rel_path}"));
    }
    Ok(full_path)
}

fn normalize_host_path(path: &str) -> PathBuf {
    let path = Path::new(path);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub fn normalize_felt_host(path: &str) -> String {
    normalize_host_path(path).display().to_string()
}

fn default_felt_host() -> String {
    env::var("PORTOLAN_FELT_HOST")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| env::var("HOME").ok().map(|home| format!("{home}/loom")))
        .unwrap_or_else(|| "loom".to_string())
}

fn sha256_hex(body: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn fiber_id_from_path(path: &str) -> Option<String> {
    let cleaned = path.strip_prefix("./").unwrap_or(path);
    let no_ext = cleaned.strip_suffix(".md")?;
    let parts: Vec<_> = no_ext.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        return None;
    }
    if parts.len() == 1 {
        return Some(parts[0].to_string());
    }
    let last = parts[parts.len() - 1];
    let second_last = parts[parts.len() - 2];
    if last != second_last {
        return None;
    }
    Some(parts[..parts.len() - 1].join("/"))
}

fn usage() -> String {
    "usage: portolan-agent-rust connect [host:port] [--ssh-host <name>] [--origin <name>] [--plannotator-port <port>] [--once]\n       portolan-agent-rust status".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use portolan_agent_protocol::{
        FiberRawOperation, FiberRawRequestPayload, FiberTreeHostsPayload, HexPosition,
    };
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use std::{
        collections::BTreeMap,
        collections::HashMap,
        ffi::OsString,
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn parses_activity_from_events_jsonl_lines() {
        let now = 1_700_000_000_000i64;
        let line = r#"{"timestamp":1700000001000,"type":"pre_tool_use","tmuxSession":"worker","tool":"Read","toolInput":{"file_path":"scratch/paper.md"}}"#;
        let activity = parse_activity_frame_from_events_jsonl_line(line, now)
            .expect("expected parseable activity");

        assert_eq!(activity.tmux_session, "worker");
        assert_eq!(activity.tool, "Read");
        assert_eq!(activity.full_path.as_deref(), Some("scratch/paper.md"));
        assert_eq!(activity.summary.as_deref(), Some("scratch/paper.md"));
        assert_eq!(activity.timestamp, 1_700_000_001_000);
    }

    #[test]
    fn truncates_activity_summary_like_node_agent() {
        let now = 1_700_000_000_000i64;
        let long_parent = "a".repeat(40);
        let line = format!(
            r#"{{"timestamp":1700000001000,"type":"post_tool_use","tmuxSession":"worker","tool":"Write","toolInput":{{"file_path":"{}/notes.md"}}}}"#,
            long_parent
        );
        let activity = parse_activity_frame_from_events_jsonl_line(&line, now)
            .expect("expected parseable activity");
        let display = format!("{long_parent}/notes.md");
        let expected = format!("…{}", &display[display.len() - 34..]);

        assert_eq!(activity.summary, Some(expected));
    }

    #[test]
    fn truncates_unicode_activity_summary_without_byte_slicing() {
        let now = 1_700_000_000_000i64;
        let long_parent = "é".repeat(40);
        let line = format!(
            r#"{{"timestamp":1700000001000,"type":"post_tool_use","tmuxSession":"worker","tool":"Write","toolInput":{{"file_path":"{}/notes.md"}}}}"#,
            long_parent
        );
        let activity = parse_activity_frame_from_events_jsonl_line(&line, now)
            .expect("expected parseable activity");
        let summary = activity.summary.expect("expected summary");

        assert!(summary.starts_with('…'));
        assert_eq!(summary.chars().count(), 35);
        assert!(summary.ends_with("/notes.md"));
    }

    #[test]
    fn ignores_non_tool_events() {
        let now = 1_700_000_000_000i64;
        let line = r#"{"timestamp":1700000001000,"type":"stop","tmuxSession":"worker","tool":"Read","toolInput":{"file_path":"scratch/paper.md"}}"#;
        let activity = parse_activity_frame_from_events_jsonl_line(line, now);

        assert!(activity.is_none());
    }

    #[test]
    fn skips_unknown_tool_summary_but_still_preserves_tool() {
        let now = 1_700_000_000_000i64;
        let line = r#"{"timestamp":1700000001000,"type":"pre_tool_use","tmuxSession":"worker","tool":"Bash","toolInput":{"file_path":"scratch/paper.md"}}"#;
        let activity = parse_activity_frame_from_events_jsonl_line(line, now)
            .expect("expected parseable activity");

        assert_eq!(activity.tool, "Bash");
        assert!(activity.summary.is_none());
        assert!(activity.full_path.is_none());
    }

    #[test]
    fn parses_multiple_activity_lines_into_frames() {
        let now = 1_700_000_000_000i64;
        let payload = r#"{"timestamp":1700000001000,"type":"pre_tool_use","tmuxSession":"worker","tool":"Read","toolInput":{"file_path":"scratch/paper.md"}}
{"timestamp":1700000002000,"type":"stop","tmuxSession":"worker","tool":"Read","toolInput":{"file_path":"scratch/paper.md"}}
{"timestamp":1700000003000,"type":"post_tool_use","tmuxSession":"editor","tool":"Write","toolInput":{"file_path":"docs/notes.md"}}
malformed
{"timestamp":1700000004000,"type":"pre_tool_use","tmuxSession":"","tool":"Read","toolInput":{"file_path":"bad/one.md"}}"#;
        let frames = parse_activity_frames_from_events_jsonl(payload, now);

        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].tmux_session, "worker");
        assert_eq!(frames[0].tool, "Read");
        assert_eq!(frames[1].tmux_session, "editor");
        assert_eq!(frames[1].tool, "Write");
    }

    fn temp_host(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!(
            "portolan-agent-test-{name}-{}-{nonce}",
            std::process::id()
        ))
    }

    #[test]
    fn parses_connect_defaults_and_options() {
        let command = parse_args(args(&[
            "connect",
            "localhost:4004",
            "--ssh-host=candide",
            "--origin",
            "login01.example",
            "--plannotator-port",
            "1738",
            "--once",
        ]))
        .unwrap();

        assert_eq!(
            command,
            AgentCommand::Connect(AgentConfig {
                server: "localhost:4004".to_string(),
                origin: "login01.example".to_string(),
                ssh_host: Some("candide".to_string()),
                plannotator_port: Some(1738),
                reconnect_interval: DEFAULT_RECONNECT_INTERVAL,
                once: true,
            })
        );
    }

    #[test]
    fn parses_tmux_panes_and_skips_agent_sessions() {
        let raw = "review\t/remote/review\t101\nportolan-agent\t/remote/agent\t102\nportolan-agent-rust-preview\t/remote/preview\t103\nworker\t\t104\n";
        let panes = parse_tmux_panes(raw);

        assert_eq!(panes.len(), 2);
        assert_eq!(
            panes
                .iter()
                .map(|pane| pane.tmux_session.as_str())
                .collect::<Vec<_>>(),
            vec!["review", "worker"]
        );
        assert_eq!(
            panes[1].cwd,
            env::current_dir().unwrap().display().to_string()
        );
    }

    #[test]
    fn detects_cli_process_from_descendants_without_real_tmux() {
        let mut commands = HashMap::<(String, String), String>::new();
        commands.insert(
            (
                "tmux".to_string(),
                "list-panes\t-a\t-F\t#{session_name}\t#{pane_current_path}\t#{pane_pid}"
                    .to_string(),
            ),
            "review\t/remote/review\t111\nanalysis\t/remote/analysis\t222\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\tcomm=\t-p\t111".to_string()),
            "bash\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\targs=\t-p\t111".to_string()),
            "bash -c run\n".to_string(),
        );
        commands.insert(
            ("pgrep".to_string(), "-P\t111".to_string()),
            "211\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\tcomm=\t-p\t211".to_string()),
            "python3\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\targs=\t-p\t211".to_string()),
            "python3 -m server\n".to_string(),
        );
        commands.insert(
            ("pgrep".to_string(), "-P\t211".to_string()),
            "311\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\tcomm=\t-p\t311".to_string()),
            "codex\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\tcomm=\t-p\t222".to_string()),
            "zsh\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\targs=\t-p\t222".to_string()),
            "zsh -i\n".to_string(),
        );
        commands.insert(("pgrep".to_string(), "-P\t222".to_string()), "".to_string());

        let sessions = collect_agent_sessions_with_runner(|program, args| {
            let key = (program.to_string(), args.join("\t"));
            commands
                .get(&key)
                .cloned()
                .ok_or_else(|| format!("unexpected command: {} {:?}", program, args))
        });

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].tmux_session, "review");
        assert_eq!(sessions[0].name, "review");
        assert_eq!(
            sessions[0].status,
            Some(portolan_agent_protocol::AgentSessionStatus::Idle)
        );
        assert_eq!(sessions[0].has_claims, Some(false));
        assert_eq!(sessions[0].has_playgrounds, Some(false));
        assert!(sessions[0].git_status.is_none());
    }

    #[test]
    fn parses_git_porcelain_status_into_file_buckets() {
        let raw = "A  added.txt\n M unstaged-mod.txt\nD  staged-del.txt\n D unstaged-del.txt\n?? untracked.txt";
        let parsed = parse_git_porcelain(raw);

        assert_eq!(parsed.staged.added, 1);
        assert_eq!(parsed.staged.modified, 0);
        assert_eq!(parsed.staged.deleted, 1);
        assert_eq!(parsed.unstaged.added, 0);
        assert_eq!(parsed.unstaged.modified, 1);
        assert_eq!(parsed.unstaged.deleted, 1);
        assert_eq!(parsed.untracked, 1);
        assert_eq!(parsed.staged.total(), 2);
        assert_eq!(parsed.unstaged.total(), 2);
    }

    #[test]
    fn parses_git_shortstat_lines_like_git_output() {
        assert_eq!(
            parse_git_shortstat("1 file changed, 3 insertions(+), 1 deletion(-)"),
            (3, 1)
        );
        assert_eq!(
            parse_git_shortstat("2 files changed, 1 insertion(+), 12 deletions(-)"),
            (1, 12)
        );
        assert_eq!(parse_git_shortstat(""), (0, 0));
    }

    #[test]
    fn collects_git_status_for_repo_sessions_and_leaves_session_discovery_intact_on_git_failures() {
        let mut commands = HashMap::<(String, String), String>::new();
        commands.insert(
            (
                "tmux".to_string(),
                "list-panes\t-a\t-F\t#{session_name}\t#{pane_current_path}\t#{pane_pid}"
                    .to_string(),
            ),
            "worker\t/remote/worker\t111\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\tcomm=\t-p\t111".to_string()),
            "claude\n".to_string(),
        );
        commands.insert(
            ("ps".to_string(), "-o\targs=\t-p\t111".to_string()),
            "claude --version\n".to_string(),
        );
        commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\trev-parse\t--is-inside-work-tree".to_string(),
            ),
            "true".to_string(),
        );
        commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\trev-parse\t--abbrev-ref\tHEAD".to_string(),
            ),
            "main".to_string(),
        );
        commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\tstatus\t--porcelain".to_string(),
            ),
            "A  added.txt\n M unstaged-mod.txt\nD  staged-del.txt\n D unstaged-del.txt\n?? untracked.txt".to_string(),
        );
        commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\trev-list\t--left-right\t--count\t@{upstream}...HEAD"
                    .to_string(),
            ),
            "2 3".to_string(),
        );
        commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\tdiff\t--cached\t--shortstat".to_string(),
            ),
            "3 insertions(+), 1 deletion(-)".to_string(),
        );
        commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\tdiff\t--shortstat".to_string(),
            ),
            "1 insertion(+), 2 deletions(-)".to_string(),
        );
        commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\tlog\t-1\t--format=%ct|||%s".to_string(),
            ),
            "1715580000|||add demo file".to_string(),
        );

        let sessions = collect_agent_sessions_with_runner(|program, args| {
            let key = (program.to_string(), args.join("\t"));
            commands
                .get(&key)
                .cloned()
                .ok_or_else(|| format!("unexpected command: {} {:?}", program, args))
        });

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].tmux_session, "worker");
        let git_status = sessions[0]
            .git_status
            .as_ref()
            .expect("expected git status for repo session");
        assert_eq!(git_status["branch"], json!("main"));
        assert_eq!(git_status["ahead"], json!(3));
        assert_eq!(git_status["behind"], json!(2));
        assert_eq!(git_status["dirty"], json!(true));
        assert_eq!(
            git_status["staged"],
            json!({ "added": 1, "modified": 0, "deleted": 1 })
        );
        assert_eq!(
            git_status["unstaged"],
            json!({ "added": 0, "modified": 1, "deleted": 1 })
        );
        assert_eq!(git_status["untracked"], json!(1));
        assert_eq!(git_status["totalFiles"], json!(5));
        assert_eq!(git_status["linesAdded"], json!(4));
        assert_eq!(git_status["linesRemoved"], json!(3));
        assert_eq!(git_status["lastCommitTime"], json!(1715580000));
        assert_eq!(git_status["lastCommitMessage"], json!("add demo file"));

        let mut partial_failure_commands = HashMap::<(String, String), String>::new();
        partial_failure_commands.insert(
            (
                "tmux".to_string(),
                "list-panes\t-a\t-F\t#{session_name}\t#{pane_current_path}\t#{pane_pid}"
                    .to_string(),
            ),
            "worker\t/remote/worker\t111\n".to_string(),
        );
        partial_failure_commands.insert(
            ("ps".to_string(), "-o\tcomm=\t-p\t111".to_string()),
            "codex\n".to_string(),
        );
        partial_failure_commands.insert(
            ("ps".to_string(), "-o\targs=\t-p\t111".to_string()),
            "".to_string(),
        );
        partial_failure_commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\trev-parse\t--is-inside-work-tree".to_string(),
            ),
            "true".to_string(),
        );
        partial_failure_commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\trev-parse\t--abbrev-ref\tHEAD".to_string(),
            ),
            "main".to_string(),
        );
        partial_failure_commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\tstatus\t--porcelain".to_string(),
            ),
            "A  added.txt".to_string(),
        );
        partial_failure_commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\trev-list\t--left-right\t--count\t@{upstream}...HEAD"
                    .to_string(),
            ),
            "2 1".to_string(),
        );

        let sessions_with_partial_git_failures =
            collect_agent_sessions_with_runner(|program, args| {
                let key = (program.to_string(), args.join("\t"));
                if let Some(output) = partial_failure_commands.get(&key) {
                    return Ok(output.clone());
                }
                if program == "git" {
                    return Err("forced git failure".to_string());
                }
                Err(format!("unexpected command: {} {:?}", program, args))
            });

        assert_eq!(sessions_with_partial_git_failures.len(), 1);
        let fallback_status = sessions_with_partial_git_failures[0]
            .git_status
            .as_ref()
            .expect("expected git status when optional git calls fail");
        assert_eq!(fallback_status["linesAdded"], json!(0));
        assert_eq!(fallback_status["linesRemoved"], json!(0));
        assert_eq!(fallback_status["lastCommitTime"], Value::Null);
        assert_eq!(fallback_status["lastCommitMessage"], Value::Null);
        assert_eq!(fallback_status["ahead"], json!(1));
        assert_eq!(fallback_status["behind"], json!(2));
        assert_eq!(fallback_status["dirty"], json!(true));

        let mut failed_commands = HashMap::<(String, String), String>::new();
        failed_commands.insert(
            (
                "tmux".to_string(),
                "list-panes\t-a\t-F\t#{session_name}\t#{pane_current_path}\t#{pane_pid}"
                    .to_string(),
            ),
            "worker\t/remote/worker\t111\n".to_string(),
        );
        failed_commands.insert(
            ("ps".to_string(), "-o\tcomm=\t-p\t111".to_string()),
            "codex\n".to_string(),
        );
        failed_commands.insert(
            ("ps".to_string(), "-o\targs=\t-p\t111".to_string()),
            "".to_string(),
        );
        failed_commands.insert(
            (
                "git".to_string(),
                "-C\t/remote/worker\trev-parse\t--is-inside-work-tree".to_string(),
            ),
            "fatal: not a git repository".to_string(),
        );

        let sessions_with_no_repo = collect_agent_sessions_with_runner(|program, args| {
            let key = (program.to_string(), args.join("\t"));
            match failed_commands.get(&key) {
                Some(output) => {
                    if program == "git" {
                        Err("not a repo".to_string())
                    } else {
                        Ok(output.clone())
                    }
                }
                None => Err(format!("unexpected command: {} {:?}", program, args)),
            }
        });

        assert_eq!(sessions_with_no_repo.len(), 1);
        assert!(sessions_with_no_repo[0].git_status.is_none());
    }

    #[test]
    fn builds_server_compatible_agent_url() {
        let url = build_agent_url(&AgentConfig {
            server: "localhost:4004".to_string(),
            origin: "login 01".to_string(),
            ssh_host: Some("cineca-login01".to_string()),
            plannotator_port: Some(4008),
            reconnect_interval: DEFAULT_RECONNECT_INTERVAL,
            once: false,
        });

        assert_eq!(
            url,
            "ws://localhost:4004/?agent=true&origin=login%2001&sshHost=cineca-login01&plannotatorPort=4008"
        );
    }

    #[test]
    fn qualifies_login_node_ssh_hosts_like_node_agent() {
        let url = build_agent_url(&AgentConfig {
            server: "localhost:4004".to_string(),
            origin: "login05.leonardo.local".to_string(),
            ssh_host: Some("cineca".to_string()),
            plannotator_port: None,
            reconnect_interval: DEFAULT_RECONNECT_INTERVAL,
            once: false,
        });

        assert_eq!(
            url,
            "ws://localhost:4004/?agent=true&origin=login05.leonardo.local&sshHost=cineca-login05"
        );
    }

    #[test]
    fn leaves_already_qualified_login_node_ssh_hosts_alone() {
        let url = build_agent_url(&AgentConfig {
            server: "localhost:4004".to_string(),
            origin: "login05.leonardo.local".to_string(),
            ssh_host: Some("cineca-login05".to_string()),
            plannotator_port: None,
            reconnect_interval: DEFAULT_RECONNECT_INTERVAL,
            once: false,
        });

        assert_eq!(
            url,
            "ws://localhost:4004/?agent=true&origin=login05.leonardo.local&sshHost=cineca-login05"
        );
    }

    #[test]
    fn leaves_non_login_ssh_hosts_alone() {
        let url = build_agent_url(&AgentConfig {
            server: "localhost:4004".to_string(),
            origin: "candide".to_string(),
            ssh_host: Some("candide".to_string()),
            plannotator_port: None,
            reconnect_interval: DEFAULT_RECONNECT_INTERVAL,
            once: false,
        });

        assert_eq!(
            url,
            "ws://localhost:4004/?agent=true&origin=candide&sshHost=candide"
        );
    }

    #[test]
    fn ignores_handshake_frames() {
        let responses = handle_server_frame(&AgentFrame::Connected {
            payload: portolan_agent_protocol::ConnectedPayload {
                origin_id: "remote-candide".to_string(),
                position: HexPosition { q: 2, r: -1 },
            },
        });

        assert_eq!(responses, vec![]);
    }

    #[test]
    fn publishes_fiber_tree_dump_for_requested_hosts() {
        let dir = temp_host("fiber-tree");
        fs::create_dir_all(dir.join(".felt/portolan/native")).unwrap();
        fs::create_dir_all(dir.join(".felt/notes")).unwrap();
        fs::write(
            dir.join(".felt/portolan/portolan.md"),
            "---\nname: Portolan\nstatus: active\n---\n\nRoot\n",
        )
        .unwrap();
        fs::write(
            dir.join(".felt/portolan/native/native.md"),
            "---\nname: Native\nstatus: open\n---\n\nChild\n",
        )
        .unwrap();
        fs::write(
            dir.join(".felt/portolan/native/scratch.md"),
            "---\nname: Not a container fiber\n---\n",
        )
        .unwrap();
        fs::write(
            dir.join(".felt/notes.md"),
            "---\nname: Notes\nstatus: closed\n---\n",
        )
        .unwrap();

        let responses = handle_server_frame(&AgentFrame::FiberTreeHosts {
            payload: FiberTreeHostsPayload {
                felt_hosts: vec![dir.display().to_string(), dir.display().to_string()],
            },
        });
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(responses.len(), 1);
        match &responses[0] {
            AgentFrame::FiberTreeDump { payload } => {
                assert_eq!(payload.felt_host, dir.display().to_string());
                let paths: Vec<_> = payload
                    .files
                    .iter()
                    .map(|file| file.path.as_str())
                    .collect();
                assert_eq!(
                    paths,
                    vec![
                        "notes.md",
                        "portolan/native/native.md",
                        "portolan/portolan.md"
                    ]
                );
                assert!(payload.files.iter().all(|file| file.fiber.is_none()));
                assert!(payload.files[0]
                    .content
                    .as_deref()
                    .unwrap()
                    .contains("name: Notes"));
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn fiber_tree_dump_prefers_felt_json_when_indexed() {
        let dir = temp_host("fiber-tree-indexed");
        fs::create_dir_all(dir.join(".felt/portolan/native")).unwrap();
        fs::write(
            dir.join(".felt/portolan/portolan.md"),
            "---\nname: Portolan markdown fallback\nstatus: active\n---\n\nRoot\n",
        )
        .unwrap();
        fs::write(
            dir.join(".felt/portolan/native/native.md"),
            "---\nname: Native markdown fallback\nstatus: open\n---\n\nChild\n",
        )
        .unwrap();
        let mut indexed = BTreeMap::new();
        indexed.insert(
            "portolan/native".to_string(),
            json!({
                "id": "portolan/native",
                "name": "Native from felt JSON",
                "status": "active",
                "body": "indexed body\n",
                "depends_on": [{ "id": "portolan" }]
            }),
        );

        let files = collect_fiber_tree_files_with_index(&dir, |_| indexed.clone()).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        let indexed_file = files
            .iter()
            .find(|file| file.path == "portolan/native/native.md")
            .expect("expected indexed child");
        assert_eq!(
            indexed_file.fiber.as_ref().unwrap()["name"],
            json!("Native from felt JSON")
        );
        assert!(indexed_file.content.is_none());

        let fallback_file = files
            .iter()
            .find(|file| file.path == "portolan/portolan.md")
            .expect("expected fallback root");
        assert!(fallback_file.fiber.is_none());
        assert!(fallback_file
            .content
            .as_deref()
            .unwrap()
            .contains("Portolan markdown fallback"));
    }

    #[test]
    fn builds_fiber_tree_delta_batch_for_watched_changes() {
        let dir = temp_host("fiber-delta");
        let fiber_dir = dir.join(".felt/portolan/native");
        fs::create_dir_all(&fiber_dir).unwrap();
        fs::write(
            fiber_dir.join("native.md"),
            "---\nname: Native\nstatus: active\n---\n\nBody\n",
        )
        .unwrap();
        let mut pending = BTreeMap::new();
        pending.insert(
            "portolan/native/native.md".to_string(),
            FiberTreeFileOp::Upsert,
        );
        pending.insert("portolan/old/old.md".to_string(), FiberTreeFileOp::Delete);

        let frame = collect_fiber_tree_delta_frame_with_snapshot(
            &dir.display().to_string(),
            &pending,
            |_, fiber_id| Ok(json!({ "id": fiber_id, "name": "Native" })),
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();

        let AgentFrame::FiberTreeDelta { payload } = frame else {
            panic!("expected delta");
        };
        assert_eq!(payload.felt_host.as_deref(), Some(dir.to_str().unwrap()));
        assert_eq!(payload.deltas.len(), 2);
        assert_eq!(payload.deltas[0].op, FiberTreeDeltaOp::Upsert);
        assert_eq!(
            payload.deltas[0].fiber.as_ref().unwrap()["id"],
            json!("portolan/native")
        );
        assert_eq!(payload.deltas[1].op, FiberTreeDeltaOp::Delete);
    }

    #[test]
    fn converts_missing_upsert_to_delete_delta() {
        let dir = temp_host("fiber-delta-missing");
        fs::create_dir_all(dir.join(".felt/portolan/native")).unwrap();
        let mut pending = BTreeMap::new();
        pending.insert(
            "portolan/native/native.md".to_string(),
            FiberTreeFileOp::Upsert,
        );

        let frame = collect_fiber_tree_delta_frame_with_snapshot(
            &dir.display().to_string(),
            &pending,
            |_, _| panic!("missing file should not be snapshotted"),
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();

        let AgentFrame::FiberTreeDelta { payload } = frame else {
            panic!("expected delta");
        };
        assert_eq!(payload.deltas.len(), 1);
        assert_eq!(payload.deltas[0].op, FiberTreeDeltaOp::Delete);
    }

    #[test]
    fn skips_missing_fiber_tree_hosts() {
        let responses = handle_server_frame(&AgentFrame::FiberTreeHosts {
            payload: FiberTreeHostsPayload {
                felt_hosts: vec!["/tmp/portolan-agent-missing-felt-host".to_string()],
            },
        });

        assert_eq!(responses, vec![]);
    }

    fn kanban_payload(entries: &[(&str, Value)]) -> AgentRequestPayload {
        let mut fields = BTreeMap::new();
        for (key, value) in entries {
            fields.insert((*key).to_string(), value.clone());
        }
        AgentRequestPayload {
            correlation_id: "abc".to_string(),
            fields,
        }
    }

    #[test]
    fn runs_shuttle_kanban_transition_and_returns_refreshed_snapshot() {
        let dir = temp_host("kanban-shuttle");
        fs::create_dir_all(dir.join(".felt/story")).unwrap();
        fs::write(dir.join(".felt/story/story.md"), "---\nname: Story\n---\n").unwrap();
        let payload = kanban_payload(&[
            ("kind", json!("shuttle")),
            ("path", json!("story/story.md")),
            ("feltHost", json!(dir.display().to_string())),
            ("fiberId", json!("story")),
            ("verb", json!("close")),
            ("tempered", json!(true)),
        ]);
        let mut invocations = Vec::new();

        let fiber = run_kanban_transition_with(
            &payload,
            |invocation| {
                invocations.push(invocation);
                Ok(())
            },
            |_, fiber_id| Ok(json!({ "id": fiber_id, "status": "closed" })),
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(fiber["id"], json!("story"));
        assert_eq!(invocations.len(), 1);
        assert_eq!(invocations[0].program, "shuttle-ctl");
        assert_eq!(
            invocations[0].args,
            vec![
                "--felt-store",
                dir.to_str().unwrap(),
                "close",
                "story",
                "--tempered=true"
            ]
        );
        assert_eq!(invocations[0].cwd, dir);
    }

    #[test]
    fn shuttle_kanban_transition_supports_outcome_and_adhoc_dispatch_flags() {
        let dir = temp_host("kanban-shuttle-flags");
        fs::create_dir_all(dir.join(".felt/story")).unwrap();
        fs::write(dir.join(".felt/story/story.md"), "---\nname: Story\n---\n").unwrap();
        let outcome = kanban_payload(&[
            ("kind", json!("shuttle")),
            ("path", json!("story/story.md")),
            ("feltHost", json!(dir.display().to_string())),
            ("fiberId", json!("story")),
            ("verb", json!("set-outcome")),
            ("outcome", json!("First line\nSecond line")),
        ]);
        let dispatch = kanban_payload(&[
            ("kind", json!("shuttle")),
            ("path", json!("story/story.md")),
            ("feltHost", json!(dir.display().to_string())),
            ("fiberId", json!("story")),
            ("verb", json!("dispatch")),
            ("adHoc", json!(true)),
        ]);
        let mut invocations = Vec::new();
        for payload in [&outcome, &dispatch] {
            run_kanban_transition_with(
                payload,
                |invocation| {
                    invocations.push(invocation);
                    Ok(())
                },
                |_, fiber_id| Ok(json!({ "id": fiber_id })),
            )
            .unwrap();
        }
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(
            invocations[0].args,
            vec![
                "--felt-store",
                dir.to_str().unwrap(),
                "set-outcome",
                "story",
                "--outcome",
                "First line\nSecond line"
            ]
        );
        assert_eq!(
            invocations[1].args,
            vec![
                "--felt-store",
                dir.to_str().unwrap(),
                "dispatch",
                "story",
                "--ad-hoc"
            ]
        );
    }

    #[test]
    fn felt_tags_kanban_transition_diffs_normalized_tags() {
        let dir = temp_host("kanban-tags");
        fs::create_dir_all(dir.join(".felt/story")).unwrap();
        fs::write(dir.join(".felt/story/story.md"), "---\nname: Story\n---\n").unwrap();
        let payload = kanban_payload(&[
            ("kind", json!("felt-tags")),
            ("path", json!("story/story.md")),
            ("feltHost", json!(dir.display().to_string())),
            ("fiberId", json!("story")),
            ("tags", json!(["active", " idea ", "idea", ""])),
        ]);
        let mut invocations = Vec::new();

        run_kanban_transition_with(
            &payload,
            |invocation| {
                invocations.push(invocation);
                Ok(())
            },
            |_, fiber_id| {
                Ok(json!({
                    "id": fiber_id,
                    "tags": ["draft", "active"]
                }))
            },
        )
        .unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(invocations.len(), 1);
        assert_eq!(invocations[0].program, "felt");
        assert_eq!(
            invocations[0].args,
            vec![
                "-C",
                dir.to_str().unwrap(),
                "edit",
                "story",
                "--untag",
                "draft",
                "--tag",
                "idea"
            ]
        );
    }

    #[test]
    fn felt_horizon_kanban_transition_rewrites_frontmatter() {
        let dir = temp_host("kanban-horizon");
        let fiber_dir = dir.join(".felt/story");
        fs::create_dir_all(&fiber_dir).unwrap();
        fs::write(
            fiber_dir.join("story.md"),
            "---\nname: Story\nnotes: |-\n  horizon: not top-level\n---\n\nBody\n",
        )
        .unwrap();
        let payload = kanban_payload(&[
            ("kind", json!("felt-horizon")),
            ("path", json!("story/story.md")),
            ("feltHost", json!(dir.display().to_string())),
            ("fiberId", json!("story")),
            ("horizon", json!("stashed")),
            ("cold", json!(true)),
        ]);
        let mut invocations = Vec::new();

        let fiber = run_kanban_transition_with(
            &payload,
            |invocation| {
                invocations.push(invocation);
                Ok(())
            },
            |_, fiber_id| Ok(json!({ "id": fiber_id, "horizon": "stashed", "cold": true })),
        )
        .unwrap();
        let saved = fs::read_to_string(fiber_dir.join("story.md")).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert!(invocations.is_empty());
        assert_eq!(fiber["horizon"], json!("stashed"));
        assert_eq!(fiber["cold"], json!(true));
        assert_eq!(
            saved,
            "---\nname: Story\nnotes: |-\n  horizon: not top-level\nhorizon: stashed\ncold: true\n---\n\nBody\n"
        );
    }

    #[test]
    fn felt_horizon_rejects_legacy_values() {
        for legacy in ["later", "someday"] {
            let err = rewrite_horizon_frontmatter("---\n---\n\n", Some(legacy), None, DueOp::Keep)
                .unwrap_err();
            assert!(
                err.contains(legacy),
                "expected error to mention {legacy}: {err}"
            );
        }
    }

    #[test]
    fn kanban_transition_reports_errors_in_result_frame() {
        let responses = handle_server_frame(&AgentFrame::KanbanTransition {
            payload: kanban_payload(&[
                ("path", json!("../escape.md")),
                ("kind", json!("shuttle")),
                ("fiberId", json!("story")),
                ("verb", json!("close")),
            ]),
        });

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].correlation_id(), Some("abc"));
        match &responses[0] {
            AgentFrame::KanbanTransitionResult { payload } => {
                assert!(!payload.ok);
                assert!(payload.error.as_deref().unwrap().contains("invalid path"));
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn reads_raw_fiber_with_sha256() {
        let dir = temp_host("raw-read");
        let fiber_dir = dir.join(".felt/portolan");
        fs::create_dir_all(&fiber_dir).unwrap();
        let body = "---\nname: Portolan\n---\n\nRemote body\n";
        fs::write(fiber_dir.join("portolan.md"), body).unwrap();

        let responses = handle_server_frame(&AgentFrame::FiberRaw {
            payload: FiberRawRequestPayload {
                correlation_id: "raw-1".to_string(),
                operation: FiberRawOperation::Read,
                path: "portolan/portolan.md".to_string(),
                felt_host: Some(dir.display().to_string()),
                body: None,
            },
        });
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].correlation_id(), Some("raw-1"));
        match &responses[0] {
            AgentFrame::FiberRawResult { payload } => {
                assert!(payload.ok);
                assert_eq!(payload.body.as_deref(), Some(body));
                assert!(payload
                    .sha256
                    .as_deref()
                    .unwrap()
                    .chars()
                    .all(|c| c.is_ascii_hexdigit()));
                assert_eq!(payload.sha256.as_deref().unwrap().len(), 64);
                assert!(payload.error.is_none());
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn writes_raw_fiber_atomically_and_returns_snapshot() {
        let dir = temp_host("raw-write");
        let fiber_dir = dir.join(".felt/portolan");
        fs::create_dir_all(&fiber_dir).unwrap();
        fs::write(
            fiber_dir.join("portolan.md"),
            "---\nname: Old\n---\n\nOld\n",
        )
        .unwrap();
        let next = "---\nname: New\nstatus: active\n---\n\nNew body\n";

        let responses = handle_server_frame(&AgentFrame::FiberRaw {
            payload: FiberRawRequestPayload {
                correlation_id: "raw-write".to_string(),
                operation: FiberRawOperation::Write,
                path: "portolan/portolan.md".to_string(),
                felt_host: Some(dir.display().to_string()),
                body: Some(next.to_string()),
            },
        });
        let saved = fs::read_to_string(fiber_dir.join("portolan.md")).unwrap();
        fs::remove_dir_all(&dir).unwrap();

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].correlation_id(), Some("raw-write"));
        match &responses[0] {
            AgentFrame::FiberRawResult { payload } => {
                assert!(payload.ok);
                assert_eq!(payload.body, None);
                assert_eq!(saved, next);
                assert!(payload
                    .sha256
                    .as_deref()
                    .unwrap()
                    .chars()
                    .all(|c| c.is_ascii_hexdigit()));
                assert_eq!(payload.sha256.as_deref().unwrap().len(), 64);
                assert_eq!(payload.fiber.as_ref().unwrap()["id"], json!("portolan"));
                assert_eq!(payload.fiber.as_ref().unwrap()["name"], json!("New"));
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn rejects_raw_fiber_writes_without_body() {
        let responses = handle_server_frame(&AgentFrame::FiberRaw {
            payload: FiberRawRequestPayload {
                correlation_id: "raw-write-missing".to_string(),
                operation: FiberRawOperation::Write,
                path: "portolan/portolan.md".to_string(),
                felt_host: Some("/tmp/portolan-agent-test".to_string()),
                body: None,
            },
        });

        match &responses[0] {
            AgentFrame::FiberRawResult { payload } => {
                assert!(!payload.ok);
                assert!(payload.error.as_deref().unwrap().contains("missing body"));
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[test]
    fn rejects_unsafe_raw_fiber_paths() {
        let responses = handle_server_frame(&AgentFrame::FiberRaw {
            payload: FiberRawRequestPayload {
                correlation_id: "raw-bad".to_string(),
                operation: FiberRawOperation::Read,
                path: "../escape.md".to_string(),
                felt_host: Some("/tmp/portolan-agent-test".to_string()),
                body: None,
            },
        });

        match &responses[0] {
            AgentFrame::FiberRawResult { payload } => {
                assert!(!payload.ok);
                assert!(payload.error.as_deref().unwrap().contains("invalid path"));
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }
}
