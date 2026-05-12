use portolan_agent_protocol::{
    is_safe_remote_fiber_path, AgentFrame, AgentRequestPayload, AgentResultPayload,
    FiberRawOperation, FiberRawRequestPayload, FiberRawResultPayload, FiberTreeDelta,
    FiberTreeDeltaOp, FiberTreeDeltaPayload, FiberTreeDumpPayload, FiberTreeFile,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_SERVER: &str = "localhost:4004";
const DEFAULT_RECONNECT_INTERVAL: Duration = Duration::from_secs(5);

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

    if let Some(ssh_host) = &config.ssh_host {
        url.push_str("&sshHost=");
        url.push_str(&urlencoding::encode(ssh_host));
    }
    if let Some(plannotator_port) = config.plannotator_port {
        url.push_str("&plannotatorPort=");
        url.push_str(&plannotator_port.to_string());
    }

    url
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
            vec![unsupported_kanban_transition(payload)]
        }
        AgentFrame::FiberRaw { payload } => vec![handle_fiber_raw(payload)],
        _ => Vec::new(),
    }
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

fn unsupported_kanban_transition(payload: &AgentRequestPayload) -> AgentFrame {
    AgentFrame::KanbanTransitionResult {
        payload: AgentResultPayload {
            correlation_id: payload.correlation_id.clone(),
            ok: false,
            error: Some(
                "rust portolan-agent preview does not implement kanban-transition yet; use server/agent.js"
                    .to_string(),
            ),
            fiber: None,
            fields: Default::default(),
        },
    }
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
    let felt_dir = felt_host.join(".felt");
    if !felt_dir.is_dir() {
        return Err(format!("{} does not exist", felt_dir.display()));
    }

    let mut paths = Vec::new();
    collect_fiber_paths(&felt_dir, &felt_dir, &mut paths);
    paths.sort();

    let mut files = Vec::new();
    for path in paths {
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
        ffi::OsString,
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
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

    #[test]
    fn returns_typed_unsupported_kanban_result() {
        let mut fields = BTreeMap::new();
        fields.insert("path".to_string(), json!("portolan/portolan.md"));
        let responses = handle_server_frame(&AgentFrame::KanbanTransition {
            payload: AgentRequestPayload {
                correlation_id: "abc".to_string(),
                fields,
            },
        });

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].correlation_id(), Some("abc"));
        match &responses[0] {
            AgentFrame::KanbanTransitionResult { payload } => {
                assert!(!payload.ok);
                assert!(payload
                    .error
                    .as_deref()
                    .unwrap()
                    .contains("server/agent.js"));
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
