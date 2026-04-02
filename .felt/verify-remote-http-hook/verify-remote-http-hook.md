---
title: Verify remote HTTP hook forwarding
status: closed
tags:
    - question
depends-on:
    - coastline-file-touch-hover
created-at: 2026-03-02T03:53:03.856379+01:00
closed-at: 2026-03-02T04:22:27.374913+01:00
outcome: 'Verified RemoteForward-based HTTP hook forwarding on live remotes. Evidence: from both candide (c02) and amundsen, ssh-executed curl http://localhost:4004/debug-runtime returned the same pid as local server (77407), proving remote localhost:4004 resolves to local portolan server over tunnel. Remote POST to /hook/file-touch with Claude-style payload succeeded ("success":true, "reason":"session-not-found" for probe session), confirming hook requests traverse tunnel and are handled by HttpApi. Added live forwarding probe to scripts/install-remote.sh: after install it now checks remote /debug-runtime reachability + pid match and runs a real remote /hook/file-touch POST probe with non-fatal warnings when local server/tunnel unavailable. No fallback script path required while SSH RemoteForward 4004 is present.'
---

(verify-remote-http-hook)=
Need to confirm Claude Code HTTP PostToolUse events from remote workers reliably reach localhost:4004 over RemoteForward. If not, define minimal fallback behavior without reintroducing conversation pipeline complexity.
