use futures_util::{SinkExt, StreamExt};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use portolan_agent::{
    active_city_felt_hosts, build_agent_url, collect_agent_sessions, collect_agent_status_snapshot,
    collect_fiber_tree_delta_frame, collect_shuttle_snapshot_frame, events_file_path,
    format_status_report, handle_server_frame, normalize_felt_host,
    parse_activity_frames_from_events_jsonl, parse_args, AgentCommand, AgentConfig,
    FiberTreeFileEvent, FiberTreeFileOp,
};
use portolan_agent_protocol::{
    AgentFrame, AgentSession, AgentSessionsUpdatePayload, FiberTreeHostsPayload,
};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{sync::mpsc, time::MissedTickBehavior};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_FELT_WATCH_DEBOUNCE_MS: u64 = 250;
const DEFAULT_FELT_POLL_MS: u64 = 5_000;
const DEFAULT_SESSION_POLL_MS: u64 = 5_000;
const DEFAULT_EVENT_POLL_MS: u64 = 1_000;
const DEFAULT_SHUTTLE_POLL_MS: u64 = 30_000;

enum ConnectExit {
    Disconnected,
    Shutdown,
}

#[tokio::main]
async fn main() {
    let command = match parse_args(env::args_os().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("{error}");
            process::exit(2);
        }
    };

    match command {
        AgentCommand::Connect(config) => run_connect_loop(config).await,
        AgentCommand::Status => {
            println!("{}", format_status_report(&collect_agent_status_snapshot()));
        }
    }
}

async fn run_connect_loop(config: AgentConfig) {
    loop {
        match connect_once(&config).await {
            Ok(ConnectExit::Shutdown) => return,
            Ok(ConnectExit::Disconnected) if config.once => return,
            Ok(ConnectExit::Disconnected) => {}
            Err(error) => eprintln!("[portolan-agent-rust] {error}"),
        }

        if config.once {
            process::exit(1);
        }
        tokio::time::sleep(config.reconnect_interval).await;
    }
}

async fn connect_once(config: &AgentConfig) -> Result<ConnectExit, String> {
    let url = build_agent_url(config);
    eprintln!("[portolan-agent-rust] connecting to {url}");
    let (stream, _) = connect_async(&url)
        .await
        .map_err(|error| format!("connect failed: {error}"))?;
    let (mut write, mut read) = stream.split();
    let (watch_tx, mut watch_rx) = mpsc::unbounded_channel();
    let mut fiber_watchers = FiberTreeWatcherSet::new(watch_tx);
    let mut pending_fiber_deltas = BTreeMap::<String, BTreeMap<String, FiberTreeFileOp>>::new();
    let mut active_city_felt_dump_hosts = HashSet::<String>::new();
    let mut flush_interval = tokio::time::interval(fiber_tree_watch_debounce());
    flush_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut poll_interval = tokio::time::interval(fiber_tree_poll_interval());
    poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut session_poll_interval = tokio::time::interval(session_poll_interval());
    session_poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut events_poll_interval = tokio::time::interval(events_poll_interval());
    events_poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let shuttle_enabled = shuttle_enabled();
    let shuttle_prefixes = shuttle_prefixes();
    let mut shuttle_poll_interval = tokio::time::interval(shuttle_poll_interval());
    shuttle_poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let events_file = events_file_path();
    let mut last_events_char_position = initial_file_position(&events_file);
    let mut events_file_started = false;

    let sessions = send_agent_session_update(&mut write).await?;
    send_active_city_fiber_tree_dumps(
        &mut write,
        &mut fiber_watchers,
        &mut active_city_felt_dump_hosts,
        &sessions,
    )
    .await?;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(ConnectExit::Shutdown),
            Some(event) = watch_rx.recv() => {
                pending_fiber_deltas
                    .entry(event.felt_host)
                    .or_default()
                    .insert(event.path, event.op);
            }
            _ = poll_interval.tick(), if fiber_watchers.has_hosts() => {
                for event in fiber_watchers.poll_changes() {
                    pending_fiber_deltas
                        .entry(event.felt_host)
                        .or_default()
                        .insert(event.path, event.op);
                }
            }
            _ = flush_interval.tick(), if !pending_fiber_deltas.is_empty() => {
                let pending = std::mem::take(&mut pending_fiber_deltas);
                for (felt_host, deltas) in pending {
                    if let Some(frame) = collect_fiber_tree_delta_frame(&felt_host, &deltas) {
                        send_agent_frame(&mut write, &frame).await?;
                    }
                }
            }
            _ = session_poll_interval.tick() => {
                let sessions = send_agent_session_update(&mut write).await?;
                send_active_city_fiber_tree_dumps(
                    &mut write,
                    &mut fiber_watchers,
                    &mut active_city_felt_dump_hosts,
                    &sessions,
                )
                .await?;
            }
            _ = events_poll_interval.tick() => {
                let frames = poll_events_file(&events_file, &mut last_events_char_position, &mut events_file_started);
                for frame in frames {
                    send_agent_frame(&mut write, &frame).await?;
                }
            }
            _ = shuttle_poll_interval.tick(), if shuttle_enabled => {
                match collect_shuttle_snapshot_frame(&shuttle_prefixes) {
                    Ok(frame) => send_agent_frame(&mut write, &frame).await?,
                    Err(error) => eprintln!("[portolan-agent-rust] shuttle snapshot skipped: {error}"),
                }
            }
            maybe_message = read.next() => {
                let Some(message) = maybe_message else { return Ok(ConnectExit::Disconnected); };
                let message = message.map_err(|error| format!("websocket read failed: {error}"))?;
                match message {
                    Message::Text(text) => handle_text_frame(&mut write, &mut fiber_watchers, text).await?,
                    Message::Binary(bytes) => handle_binary_frame(&mut write, &mut fiber_watchers, bytes).await?,
                    Message::Close(_) => return Ok(ConnectExit::Disconnected),
                    Message::Ping(bytes) => write.send(Message::Pong(bytes)).await.map_err(|error| format!("send pong failed: {error}"))?,
                    Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
}

fn initial_file_position(events_file: &Path) -> usize {
    match fs::read_to_string(events_file) {
        Ok(content) => content.len(),
        Err(_) => 0,
    }
}

fn events_poll_interval() -> Duration {
    env::var("PORTOLAN_EVENTS_POLL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|millis| *millis > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_EVENT_POLL_MS))
}

fn shuttle_enabled() -> bool {
    env::var("PORTOLAN_SHUTTLE_ENABLED").ok().as_deref() == Some("1")
}

fn shuttle_prefixes() -> Vec<String> {
    env::var("PORTOLAN_SHUTTLE_PREFIXES")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|prefix| !prefix.is_empty())
        .map(str::to_string)
        .collect()
}

fn shuttle_poll_interval() -> Duration {
    env::var("PORTOLAN_SHUTTLE_INTERVAL_MS")
        .or_else(|_| env::var("PORTOLAN_SHUTTLE_POLL_MS"))
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|millis| *millis > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_SHUTTLE_POLL_MS))
}

fn poll_events_file(
    events_file: &Path,
    last_events_char_position: &mut usize,
    started_once: &mut bool,
) -> Vec<AgentFrame> {
    if !events_file.exists() {
        if !*started_once {
            eprintln!(
                "[portolan-agent-rust] events file not found: {}",
                events_file.display()
            );
            eprintln!("[portolan-agent-rust] activity tracking disabled");
            *started_once = true;
        }
        return Vec::new();
    }

    let Ok(content) = fs::read_to_string(events_file) else {
        return Vec::new();
    };

    if content.len() < *last_events_char_position {
        *last_events_char_position = 0;
    }

    if content.len() <= *last_events_char_position {
        return Vec::new();
    }

    let new_content = &content[*last_events_char_position..];
    *last_events_char_position = content.len();
    let fallback_timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_millis() as i64);

    parse_activity_frames_from_events_jsonl(new_content, fallback_timestamp)
        .into_iter()
        .map(|activity| AgentFrame::AgentActivity { activity })
        .collect()
}

async fn handle_text_frame<W>(
    write: &mut W,
    fiber_watchers: &mut FiberTreeWatcherSet,
    text: String,
) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let frame = AgentFrame::parse(text.as_bytes())
        .map_err(|error| format!("parse server frame failed: {error}"))?;
    watch_requested_fiber_hosts(fiber_watchers, &frame);
    send_responses(write, handle_server_frame(&frame)).await
}

async fn handle_binary_frame<W>(
    write: &mut W,
    fiber_watchers: &mut FiberTreeWatcherSet,
    bytes: Vec<u8>,
) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let frame =
        AgentFrame::parse(bytes).map_err(|error| format!("parse server frame failed: {error}"))?;
    watch_requested_fiber_hosts(fiber_watchers, &frame);
    send_responses(write, handle_server_frame(&frame)).await
}

fn watch_requested_fiber_hosts(fiber_watchers: &mut FiberTreeWatcherSet, frame: &AgentFrame) {
    let AgentFrame::FiberTreeHosts { payload } = frame else {
        return;
    };
    for host in &payload.felt_hosts {
        if let Err(error) = fiber_watchers.watch_host(host) {
            eprintln!("[portolan-agent-rust] fiber-tree watcher skipped for {host}: {error}");
        }
    }
}

async fn send_responses<W>(write: &mut W, responses: Vec<AgentFrame>) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    for response in responses {
        send_agent_frame(write, &response).await?;
    }
    Ok(())
}

async fn send_agent_frame<W>(write: &mut W, frame: &AgentFrame) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    write
        .send(Message::Text(frame.to_json_string().map_err(|error| {
            format!("encode response failed: {error}")
        })?))
        .await
        .map_err(|error| format!("send response failed: {error}"))
}

fn fiber_tree_watch_debounce() -> Duration {
    env::var("PORTOLAN_FELT_DEBOUNCE_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|millis| *millis > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_FELT_WATCH_DEBOUNCE_MS))
}

fn session_poll_interval() -> Duration {
    env::var("PORTOLAN_SESSION_POLL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|millis| *millis > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_SESSION_POLL_MS))
}

async fn send_agent_session_update<W>(write: &mut W) -> Result<Vec<AgentSession>, String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let sessions = collect_agent_sessions();
    let frame = AgentFrame::AgentSessionsUpdate {
        payload: AgentSessionsUpdatePayload {
            sessions: sessions.clone(),
        },
    };
    send_agent_frame(write, &frame).await?;
    Ok(sessions)
}

async fn send_active_city_fiber_tree_dumps<W>(
    write: &mut W,
    fiber_watchers: &mut FiberTreeWatcherSet,
    sent_hosts: &mut HashSet<String>,
    sessions: &[AgentSession],
) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let active_hosts = active_city_felt_hosts(sessions, &default_felt_host_path());
    let active_host_set = active_hosts.iter().cloned().collect::<HashSet<_>>();
    sent_hosts.retain(|host| active_host_set.contains(host));

    for host in active_hosts {
        if let Err(error) = fiber_watchers.watch_host(&host) {
            eprintln!("[portolan-agent-rust] fiber-tree watcher skipped for {host}: {error}");
        }
        if !sent_hosts.insert(host.clone()) {
            continue;
        }
        let frame = AgentFrame::FiberTreeHosts {
            payload: FiberTreeHostsPayload {
                felt_hosts: vec![host],
            },
        };
        send_responses(write, handle_server_frame(&frame)).await?;
    }
    Ok(())
}

fn default_felt_host_path() -> PathBuf {
    env::var("PORTOLAN_FELT_HOST")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var("HOME")
                .ok()
                .map(|home| Path::new(&home).join("loom"))
        })
        .unwrap_or_else(|| PathBuf::from("loom"))
}

fn fiber_tree_poll_interval() -> Duration {
    env::var("PORTOLAN_FELT_POLL_MS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|millis| *millis > 0)
        .map(Duration::from_millis)
        .unwrap_or_else(|| Duration::from_millis(DEFAULT_FELT_POLL_MS))
}

struct FiberTreeWatcherSet {
    tx: mpsc::UnboundedSender<FiberTreeFileEvent>,
    watchers: HashMap<String, RecommendedWatcher>,
    unsupported: HashSet<String>,
    fingerprints: HashMap<String, BTreeMap<String, FileFingerprint>>,
}

impl FiberTreeWatcherSet {
    fn new(tx: mpsc::UnboundedSender<FiberTreeFileEvent>) -> Self {
        Self {
            tx,
            watchers: HashMap::new(),
            unsupported: HashSet::new(),
            fingerprints: HashMap::new(),
        }
    }

    fn watch_host(&mut self, felt_host: &str) -> Result<(), String> {
        let normalized_host = normalize_felt_host(felt_host);
        if self.fingerprints.contains_key(&normalized_host)
            || self.watchers.contains_key(&normalized_host)
            || self.unsupported.contains(&normalized_host)
        {
            return Ok(());
        }
        let felt_dir = Path::new(&normalized_host).join(".felt");
        if !felt_dir.is_dir() {
            return Err(format!("{} does not exist", felt_dir.display()));
        }
        self.fingerprints.insert(
            normalized_host.clone(),
            scan_fiber_tree_fingerprints(&felt_dir),
        );

        let tx = self.tx.clone();
        let host_for_event = normalized_host.clone();
        let felt_dir_for_event = felt_dir.clone();
        let mut watcher = match notify::recommended_watcher(
            move |event: Result<Event, notify::Error>| {
                let Ok(event) = event else {
                    return;
                };
                for path in event.paths {
                    if let Some(file_event) =
                        watched_path_to_fiber_event(&host_for_event, &felt_dir_for_event, path)
                    {
                        let _ = tx.send(file_event);
                    }
                }
            },
        ) {
            Ok(watcher) => watcher,
            Err(error) => {
                self.unsupported.insert(normalized_host.clone());
                eprintln!(
                    "[portolan-agent-rust] fiber-tree watcher unsupported for {}; falling back to polling: {error}",
                    felt_dir.display()
                );
                return Ok(());
            }
        };

        if let Err(error) = watcher.watch(&felt_dir, RecursiveMode::Recursive) {
            self.unsupported.insert(normalized_host.clone());
            eprintln!(
                "[portolan-agent-rust] fiber-tree watcher unsupported for {}; falling back to polling: {error}",
                felt_dir.display()
            );
            return Ok(());
        }
        eprintln!(
            "[portolan-agent-rust] watching fiber tree: {}",
            felt_dir.display()
        );
        self.watchers.insert(normalized_host, watcher);
        Ok(())
    }

    fn has_hosts(&self) -> bool {
        !self.fingerprints.is_empty()
    }

    fn poll_changes(&mut self) -> Vec<FiberTreeFileEvent> {
        let mut events = Vec::new();
        let hosts: Vec<_> = self.fingerprints.keys().cloned().collect();
        for felt_host in hosts {
            let felt_dir = Path::new(&felt_host).join(".felt");
            let next = scan_fiber_tree_fingerprints(&felt_dir);
            let previous = self
                .fingerprints
                .get(&felt_host)
                .cloned()
                .unwrap_or_default();

            for (path, fingerprint) in &next {
                if previous.get(path) != Some(fingerprint) {
                    events.push(FiberTreeFileEvent {
                        felt_host: felt_host.clone(),
                        path: path.clone(),
                        op: FiberTreeFileOp::Upsert,
                    });
                }
            }
            for path in previous.keys() {
                if !next.contains_key(path) {
                    events.push(FiberTreeFileEvent {
                        felt_host: felt_host.clone(),
                        path: path.clone(),
                        op: FiberTreeFileOp::Delete,
                    });
                }
            }

            self.fingerprints.insert(felt_host, next);
        }
        events
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileFingerprint {
    modified_nanos: Option<u128>,
    len: u64,
}

fn scan_fiber_tree_fingerprints(felt_dir: &Path) -> BTreeMap<String, FileFingerprint> {
    let mut out = BTreeMap::new();
    scan_fiber_tree_fingerprints_into(felt_dir, felt_dir, &mut out);
    out
}

fn scan_fiber_tree_fingerprints_into(
    root: &Path,
    current: &Path,
    out: &mut BTreeMap<String, FileFingerprint>,
) {
    let Ok(entries) = fs::read_dir(current) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() {
            scan_fiber_tree_fingerprints_into(root, &path, out);
            continue;
        }
        if !file_type.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let Ok(rel_path) = path.strip_prefix(root) else {
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified_nanos = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos());
        out.insert(
            rel_path
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/"),
            FileFingerprint {
                modified_nanos,
                len: metadata.len(),
            },
        );
    }
}

fn watched_path_to_fiber_event(
    felt_host: &str,
    felt_dir: &Path,
    path: PathBuf,
) -> Option<FiberTreeFileEvent> {
    let full_path = if path.is_absolute() {
        path
    } else {
        felt_dir.join(path)
    };
    if full_path.extension().and_then(|ext| ext.to_str()) != Some("md") {
        return None;
    }
    let rel_path = full_path
        .strip_prefix(felt_dir)
        .ok()?
        .to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/");
    let op = if full_path.exists() {
        FiberTreeFileOp::Upsert
    } else {
        FiberTreeFileOp::Delete
    };
    Some(FiberTreeFileEvent {
        felt_host: felt_host.to_string(),
        path: rel_path,
        op,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(cwd: &str) -> AgentSession {
        AgentSession {
            id: None,
            name: "worker".to_string(),
            tmux_session: "worker".to_string(),
            cwd: cwd.to_string(),
            status: None,
            has_claims: None,
            has_playgrounds: None,
            git_status: None,
        }
    }

    fn temp_events_file(tag: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "portolan-agent-rust-preview-{tag}-{}.jsonl",
            process::id()
        ))
    }

    fn write_events_file(path: &Path, lines: &str) {
        fs::write(path, lines).unwrap();
    }

    #[test]
    fn polls_events_file_incrementally() {
        let path = temp_events_file("incremental");
        let mut cursor = 0usize;
        let mut started = false;

        let initial = r#"{"timestamp":1700000001000,"type":"pre_tool_use","tmuxSession":"worker","tool":"Read","toolInput":{"file_path":"notes/workbench.md"}}
"#;
        write_events_file(&path, initial);

        let frames = poll_events_file(&path, &mut cursor, &mut started);
        assert_eq!(frames.len(), 1);
        let AgentFrame::AgentActivity { activity } = &frames[0] else {
            panic!("expected AgentActivity frame");
        };
        assert_eq!(activity.tmux_session, "worker");

        let frames = poll_events_file(&path, &mut cursor, &mut started);
        assert_eq!(frames.len(), 0);

        let appended = format!(
            "{}{}",
            initial,
            r#"{"timestamp":1700000002000,"type":"post_tool_use","tmuxSession":"editor","tool":"Write","toolInput":{"file_path":"notes/final.md"}}
"#,
        );
        write_events_file(&path, &appended);

        let frames = poll_events_file(&path, &mut cursor, &mut started);
        assert_eq!(frames.len(), 1);
        let AgentFrame::AgentActivity { activity } = &frames[0] else {
            panic!("expected AgentActivity frame");
        };
        assert_eq!(activity.tmux_session, "editor");
        assert_eq!(activity.tool, "Write");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn poll_events_file_recovers_from_truncation() {
        let path = temp_events_file("truncate");
        let mut cursor = 0usize;
        let mut started = false;

        write_events_file(
            &path,
            r#"{"timestamp":1700000001000,"type":"pre_tool_use","tmuxSession":"worker","tool":"Read","toolInput":{"file_path":"notes/a.md"}}
"#,
        );
        let first = poll_events_file(&path, &mut cursor, &mut started);
        assert_eq!(first.len(), 1);

        write_events_file(&path, "");
        let _ = poll_events_file(&path, &mut cursor, &mut started);

        write_events_file(
            &path,
            r#"{"timestamp":1700000002000,"type":"post_tool_use","tmuxSession":"worker","tool":"Edit","toolInput":{"file_path":"notes/b.md"}}
"#,
        );
        let second = poll_events_file(&path, &mut cursor, &mut started);
        assert_eq!(second.len(), 1);
        let AgentFrame::AgentActivity { activity } = &second[0] else {
            panic!("expected AgentActivity frame");
        };
        assert_eq!(activity.tool, "Edit");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn active_city_felt_hosts_skip_default_and_missing_felt_dirs() {
        let default_host = Path::new("/Users/cail/loom");
        let sessions = vec![
            session("/Users/cail/loom"),
            session("/work/project-a"),
            session("/work/project-b"),
            session("/work/project-a"),
            session(""),
        ];

        let hosts = portolan_agent::active_city_felt_hosts_with_probe(
            &sessions,
            default_host,
            |felt_dir| felt_dir == Path::new("/work/project-a/.felt"),
        );

        assert_eq!(hosts, vec!["/work/project-a"]);
    }

    #[test]
    fn active_city_felt_hosts_normalize_relative_cwds() {
        let default_host = Path::new("/Users/cail/loom");
        let sessions = vec![session("./relative-city")];
        let normalized = normalize_felt_host("./relative-city");

        let hosts = portolan_agent::active_city_felt_hosts_with_probe(
            &sessions,
            default_host,
            |felt_dir| felt_dir == Path::new(&normalized).join(".felt"),
        );

        assert_eq!(hosts, vec![normalized]);
    }
}
