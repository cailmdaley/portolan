use portolan_agent_protocol::{
    AgentFrame, AgentRequestPayload, AgentResultPayload, FiberRawRequestPayload,
    FiberRawResultPayload,
};
use std::{env, ffi::OsString, time::Duration};

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
        AgentFrame::FiberTreeHosts { payload } => {
            eprintln!(
                "[portolan-agent-rust] server requested {} felt host(s); fiber-tree publishing is not enabled in the preview binary",
                payload.felt_hosts.len()
            );
            Vec::new()
        }
        AgentFrame::KanbanTransition { payload } => {
            vec![unsupported_kanban_transition(payload)]
        }
        AgentFrame::FiberRaw { payload } => vec![unsupported_fiber_raw(payload)],
        _ => Vec::new(),
    }
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

fn unsupported_fiber_raw(payload: &FiberRawRequestPayload) -> AgentFrame {
    AgentFrame::FiberRawResult {
        payload: FiberRawResultPayload {
            correlation_id: payload.correlation_id.clone(),
            ok: false,
            error: Some(
                "rust portolan-agent preview does not implement fiber-raw yet; use server/agent.js"
                    .to_string(),
            ),
            body: None,
            sha256: None,
            fiber: None,
        },
    }
}

fn usage() -> String {
    "usage: portolan-agent-rust connect [host:port] [--ssh-host <name>] [--origin <name>] [--plannotator-port <port>] [--once]\n       portolan-agent-rust status".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use portolan_agent_protocol::{FiberRawOperation, FiberRawRequestPayload, HexPosition};
    use pretty_assertions::assert_eq;
    use serde_json::json;
    use std::{collections::BTreeMap, ffi::OsString};

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
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
    fn returns_typed_unsupported_fiber_raw_result() {
        let responses = handle_server_frame(&AgentFrame::FiberRaw {
            payload: FiberRawRequestPayload {
                correlation_id: "raw-1".to_string(),
                operation: FiberRawOperation::Read,
                path: "portolan/portolan.md".to_string(),
                felt_host: Some("/Users/cd280747/loom".to_string()),
                body: None,
            },
        });

        assert_eq!(responses.len(), 1);
        assert_eq!(responses[0].correlation_id(), Some("raw-1"));
        match &responses[0] {
            AgentFrame::FiberRawResult { payload } => {
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
}
