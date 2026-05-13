use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::BTreeMap, error::Error, fmt};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgentFrame {
    #[serde(rename = "connected")]
    Connected { payload: ConnectedPayload },
    #[serde(rename = "fiber_tree_hosts")]
    FiberTreeHosts { payload: FiberTreeHostsPayload },
    #[serde(rename = "agent_sessions_update")]
    AgentSessionsUpdate { payload: AgentSessionsUpdatePayload },
    #[serde(rename = "agent_activity")]
    AgentActivity { activity: AgentActivity },
    #[serde(rename = "fiber_tree_dump")]
    FiberTreeDump { payload: FiberTreeDumpPayload },
    #[serde(rename = "fiber_tree_delta")]
    FiberTreeDelta { payload: FiberTreeDeltaPayload },
    #[serde(rename = "kanban-transition")]
    KanbanTransition { payload: AgentRequestPayload },
    #[serde(rename = "kanban-transition-result")]
    KanbanTransitionResult { payload: AgentResultPayload },
    #[serde(rename = "fiber-raw")]
    FiberRaw { payload: FiberRawRequestPayload },
    #[serde(rename = "fiber-raw-result")]
    FiberRawResult { payload: FiberRawResultPayload },
    #[serde(rename = "fiber-history")]
    FiberHistory { payload: FiberHistoryRequestPayload },
    #[serde(rename = "fiber-history-result")]
    FiberHistoryResult { payload: FiberHistoryResultPayload },
    #[serde(rename = "shuttle_snapshot")]
    ShuttleSnapshot { payload: ShuttleSnapshotPayload },
}

impl AgentFrame {
    pub fn parse(input: impl AsRef<[u8]>) -> Result<Self, ProtocolError> {
        serde_json::from_slice(input.as_ref()).map_err(ProtocolError::InvalidJson)
    }

    pub fn to_json_string(&self) -> Result<String, ProtocolError> {
        serde_json::to_string(self).map_err(ProtocolError::InvalidJson)
    }

    pub fn correlation_id(&self) -> Option<&str> {
        match self {
            AgentFrame::KanbanTransition { payload } => Some(payload.correlation_id.as_str()),
            AgentFrame::KanbanTransitionResult { payload } => Some(payload.correlation_id.as_str()),
            AgentFrame::FiberRaw { payload } => Some(payload.correlation_id.as_str()),
            AgentFrame::FiberRawResult { payload } => Some(payload.correlation_id.as_str()),
            AgentFrame::FiberHistory { payload } => Some(payload.correlation_id.as_str()),
            AgentFrame::FiberHistoryResult { payload } => Some(payload.correlation_id.as_str()),
            _ => None,
        }
    }

    pub fn is_server_request(&self) -> bool {
        matches!(
            self,
            AgentFrame::KanbanTransition { .. }
                | AgentFrame::FiberRaw { .. }
                | AgentFrame::FiberHistory { .. }
        )
    }

    pub fn is_agent_result(&self) -> bool {
        matches!(
            self,
            AgentFrame::KanbanTransitionResult { .. }
                | AgentFrame::FiberRawResult { .. }
                | AgentFrame::FiberHistoryResult { .. }
        )
    }
}

#[derive(Debug)]
pub enum ProtocolError {
    InvalidJson(serde_json::Error),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ProtocolError::InvalidJson(error) => write!(f, "invalid protocol JSON: {error}"),
        }
    }
}

impl Error for ProtocolError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedPayload {
    pub origin_id: String,
    pub position: HexPosition,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct HexPosition {
    pub q: i32,
    pub r: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiberTreeHostsPayload {
    pub felt_hosts: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentSessionsUpdatePayload {
    pub sessions: Vec<AgentSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub tmux_session: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<AgentSessionStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_claims: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_playgrounds: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub git_status: Option<Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionStatus {
    Idle,
    Working,
    Offline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivity {
    pub tmux_session: String,
    pub tool: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub full_path: Option<String>,
    pub timestamp: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiberTreeDumpPayload {
    pub felt_host: String,
    pub files: Vec<FiberTreeFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FiberTreeFile {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiber: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiberTreeDeltaPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub felt_host: Option<String>,
    pub deltas: Vec<FiberTreeDelta>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FiberTreeDelta {
    pub path: String,
    pub op: FiberTreeDeltaOp,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiber: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FiberTreeDeltaOp {
    Upsert,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestPayload {
    pub correlation_id: String,
    #[serde(flatten)]
    pub fields: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentResultPayload {
    pub correlation_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiber: Option<Value>,
    #[serde(flatten)]
    pub fields: BTreeMap<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiberRawRequestPayload {
    pub correlation_id: String,
    pub operation: FiberRawOperation,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub felt_host: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FiberRawOperation {
    Read,
    Write,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiberRawResultPayload {
    pub correlation_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fiber: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiberHistoryRequestPayload {
    pub correlation_id: String,
    pub slug: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub felt_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FiberHistoryResultPayload {
    pub correlation_id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub events: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ShuttleSnapshotPayload {
    #[serde(flatten)]
    pub fields: BTreeMap<String, Value>,
}

pub fn is_safe_remote_fiber_path(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use serde_json::json;

    #[test]
    fn parses_agent_sessions_update() {
        let frame = AgentFrame::parse(
            br#"{
              "type": "agent_sessions_update",
              "payload": {
                "sessions": [{
                  "name": "review",
                  "tmuxSession": "review",
                  "cwd": "/automnt/n17data/cdaley/unions/pure_eb",
                  "status": "working",
                  "hasClaims": true,
                  "hasPlaygrounds": false,
                  "gitStatus": {"dirty": true}
                }]
              }
            }"#,
        )
        .unwrap();

        let AgentFrame::AgentSessionsUpdate { payload } = frame else {
            panic!("expected sessions update");
        };
        assert_eq!(payload.sessions[0].tmux_session, "review");
        assert_eq!(
            payload.sessions[0].status,
            Some(AgentSessionStatus::Working)
        );
        assert_eq!(payload.sessions[0].has_claims, Some(true));
    }

    #[test]
    fn parses_activity_frame_with_camel_case_path() {
        let frame = AgentFrame::parse(
            br#"{
              "type": "agent_activity",
              "activity": {
                "tmuxSession": "paper",
                "tool": "Read",
                "summary": "pure_eb/slides.qmd",
                "fullPath": "/remote/pure_eb/slides.qmd",
                "timestamp": 1234
              }
            }"#,
        )
        .unwrap();

        let AgentFrame::AgentActivity { activity } = frame else {
            panic!("expected activity");
        };
        assert_eq!(
            activity.full_path.as_deref(),
            Some("/remote/pure_eb/slides.qmd")
        );
    }

    #[test]
    fn parses_fiber_tree_dump_and_delta() {
        let dump = AgentFrame::parse(
            br#"{
              "type": "fiber_tree_dump",
              "payload": {
                "feltHost": "/home/cdaley/loom",
                "files": [{
                  "path": "ai-futures/portolan/portolan.md",
                  "fiber": {"id": "ai-futures/portolan", "name": "Portolan"}
                }]
              }
            }"#,
        )
        .unwrap();
        let AgentFrame::FiberTreeDump { payload } = dump else {
            panic!("expected dump");
        };
        assert_eq!(payload.felt_host, "/home/cdaley/loom");
        assert_eq!(payload.files[0].fiber.as_ref().unwrap()["name"], "Portolan");

        let delta = AgentFrame::parse(
            br#"{
              "type": "fiber_tree_delta",
              "payload": {
                "feltHost": "/home/cdaley/loom",
                "deltas": [{"path": "x/x.md", "op": "delete"}]
              }
            }"#,
        )
        .unwrap();
        let AgentFrame::FiberTreeDelta { payload } = delta else {
            panic!("expected delta");
        };
        assert_eq!(payload.deltas[0].op, FiberTreeDeltaOp::Delete);
    }

    #[test]
    fn preserves_open_kanban_transition_payload_fields() {
        let frame = AgentFrame::parse(
            br#"{
              "type": "kanban-transition",
              "payload": {
                "correlationId": "corr-1",
                "feltHost": "/home/cdaley/loom",
                "path": "ai-futures/portolan/portolan.md",
                "kind": "status",
                "status": "closed"
              }
            }"#,
        )
        .unwrap();

        assert!(frame.is_server_request());
        assert_eq!(frame.correlation_id(), Some("corr-1"));
        let AgentFrame::KanbanTransition { payload } = frame else {
            panic!("expected request");
        };
        assert_eq!(payload.fields["kind"], "status");
        assert_eq!(payload.fields["path"], "ai-futures/portolan/portolan.md");
    }

    #[test]
    fn parses_fiber_raw_round_trip() {
        let request = AgentFrame::FiberRaw {
            payload: FiberRawRequestPayload {
                correlation_id: "corr-2".to_string(),
                operation: FiberRawOperation::Write,
                path: "editable/editable.md".to_string(),
                felt_host: Some("/home/cdaley/loom".to_string()),
                body: Some("---\nname: Editable\n---\n".to_string()),
            },
        };
        let encoded = request.to_json_string().unwrap();
        assert!(encoded.contains(r#""type":"fiber-raw""#));
        assert!(encoded.contains(r#""correlationId":"corr-2""#));

        let result = AgentFrame::parse(
            br#"{
              "type": "fiber-raw-result",
              "payload": {
                "correlationId": "corr-2",
                "ok": true,
                "sha256": "abc123",
                "fiber": {"id": "editable", "status": "active"}
              }
            }"#,
        )
        .unwrap();
        assert!(result.is_agent_result());
        assert_eq!(result.correlation_id(), Some("corr-2"));
    }

    #[test]
    fn parses_fiber_history_round_trip() {
        let request = AgentFrame::FiberHistory {
            payload: FiberHistoryRequestPayload {
                correlation_id: "corr-history".to_string(),
                slug: "portolan/native".to_string(),
                felt_host: Some("/home/cdaley/loom".to_string()),
            },
        };
        let encoded = request.to_json_string().unwrap();
        assert!(encoded.contains(r#""type":"fiber-history""#));
        assert!(encoded.contains(r#""correlationId":"corr-history""#));

        let result = AgentFrame::parse(
            br#"{
              "type": "fiber-history-result",
              "payload": {
                "correlationId": "corr-history",
                "ok": true,
                "events": [{"event_type": "editorial"}]
              }
            }"#,
        )
        .unwrap();
        assert!(result.is_agent_result());
        assert_eq!(result.correlation_id(), Some("corr-history"));
    }

    #[test]
    fn keeps_unknown_shuttle_snapshot_shape_available() {
        let frame = AgentFrame::parse(
            br#"{
              "type": "shuttle_snapshot",
              "payload": {
                "eligible": [{"id": "x"}],
                "running": [],
                "standing": {"count": 0}
              }
            }"#,
        )
        .unwrap();
        let AgentFrame::ShuttleSnapshot { payload } = frame else {
            panic!("expected shuttle snapshot");
        };
        assert_eq!(payload.fields["eligible"], json!([{ "id": "x" }]));
    }

    #[test]
    fn rejects_unknown_frame_types() {
        let err = AgentFrame::parse(br#"{"type":"not-real","payload":{}}"#).unwrap_err();
        assert!(err.to_string().contains("not-real"));
    }

    #[test]
    fn validates_remote_fiber_paths_like_the_node_agent() {
        assert!(is_safe_remote_fiber_path("editable/editable.md"));
        assert!(is_safe_remote_fiber_path("ai-futures/portolan/portolan.md"));
        assert!(!is_safe_remote_fiber_path(""));
        assert!(!is_safe_remote_fiber_path("/absolute.md"));
        assert!(!is_safe_remote_fiber_path("../escape.md"));
        assert!(!is_safe_remote_fiber_path("fiber//fiber.md"));
        assert!(!is_safe_remote_fiber_path("fiber/./fiber.md"));
    }
}
