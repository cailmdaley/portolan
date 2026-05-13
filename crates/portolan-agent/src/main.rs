use futures_util::{SinkExt, StreamExt};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use portolan_agent::{
    build_agent_url, collect_agent_sessions, collect_fiber_tree_delta_frame, handle_server_frame,
    normalize_felt_host, parse_args, AgentCommand, AgentConfig, FiberTreeFileEvent,
    FiberTreeFileOp,
};
use portolan_agent_protocol::{AgentFrame, AgentSessionsUpdatePayload};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process,
    time::{Duration, UNIX_EPOCH},
};
use tokio::{sync::mpsc, time::MissedTickBehavior};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const DEFAULT_FELT_WATCH_DEBOUNCE_MS: u64 = 250;
const DEFAULT_FELT_POLL_MS: u64 = 5_000;
const DEFAULT_SESSION_POLL_MS: u64 = 5_000;

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
            println!(
                "rust portolan-agent preview installed; Node server/agent.js remains authoritative"
            );
        }
    }
}

async fn run_connect_loop(config: AgentConfig) {
    loop {
        match connect_once(&config).await {
            Ok(()) if config.once => return,
            Ok(()) => {}
            Err(error) => eprintln!("[portolan-agent-rust] {error}"),
        }

        if config.once {
            process::exit(1);
        }
        tokio::time::sleep(config.reconnect_interval).await;
    }
}

async fn connect_once(config: &AgentConfig) -> Result<(), String> {
    let url = build_agent_url(config);
    eprintln!("[portolan-agent-rust] connecting to {url}");
    let (stream, _) = connect_async(&url)
        .await
        .map_err(|error| format!("connect failed: {error}"))?;
    let (mut write, mut read) = stream.split();
    let (watch_tx, mut watch_rx) = mpsc::unbounded_channel();
    let mut fiber_watchers = FiberTreeWatcherSet::new(watch_tx);
    let mut pending_fiber_deltas = BTreeMap::<String, BTreeMap<String, FiberTreeFileOp>>::new();
    let mut flush_interval = tokio::time::interval(fiber_tree_watch_debounce());
    flush_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut poll_interval = tokio::time::interval(fiber_tree_poll_interval());
    poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut session_poll_interval = tokio::time::interval(session_poll_interval());
    session_poll_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    send_agent_session_update(&mut write).await?;

    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => return Ok(()),
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
                send_agent_session_update(&mut write).await?;
            }
            maybe_message = read.next() => {
                let Some(message) = maybe_message else { return Ok(()); };
                let message = message.map_err(|error| format!("websocket read failed: {error}"))?;
                match message {
                    Message::Text(text) => handle_text_frame(&mut write, &mut fiber_watchers, text).await?,
                    Message::Binary(bytes) => handle_binary_frame(&mut write, &mut fiber_watchers, bytes).await?,
                    Message::Close(_) => return Ok(()),
                    Message::Ping(bytes) => write.send(Message::Pong(bytes)).await.map_err(|error| format!("send pong failed: {error}"))?,
                    Message::Pong(_) | Message::Frame(_) => {}
                }
            }
        }
    }
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

async fn send_agent_session_update<W>(write: &mut W) -> Result<(), String>
where
    W: futures_util::Sink<Message> + Unpin,
    <W as futures_util::Sink<Message>>::Error: std::fmt::Display,
{
    let sessions = collect_agent_sessions();
    let frame = AgentFrame::AgentSessionsUpdate {
        payload: AgentSessionsUpdatePayload { sessions },
    };
    send_agent_frame(write, &frame).await
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
