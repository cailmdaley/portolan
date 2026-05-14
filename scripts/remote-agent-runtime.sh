#!/usr/bin/env bash

# Shared remote-agent tmux session naming for operator scripts.
# The legacy preview session remains a cleanup target so canonical Rust startup
# does not leave a stale second Rust-owned socket behind.

: "${NODE_AGENT_SESSION:=portolan-agent}"
: "${RUST_AGENT_SESSION:=portolan-agent-rust}"
: "${LEGACY_RUST_AGENT_SESSION:=portolan-agent-rust-preview}"

remote_agent_tmux_session() {
  case "$1" in
    rust)
      printf '%s\n' "$RUST_AGENT_SESSION"
      ;;
    node)
      printf '%s\n' "$NODE_AGENT_SESSION"
      ;;
    *)
      echo "unknown remote-agent runtime: $1" >&2
      return 1
      ;;
  esac
}

replaced_remote_agent_tmux_sessions() {
  case "$1" in
    rust)
      printf '%s\n%s\n' "$NODE_AGENT_SESSION" "$LEGACY_RUST_AGENT_SESSION"
      ;;
    node)
      printf '%s\n%s\n' "$RUST_AGENT_SESSION" "$LEGACY_RUST_AGENT_SESSION"
      ;;
    *)
      echo "unknown remote-agent runtime: $1" >&2
      return 1
      ;;
  esac
}
