---
title: Portolan performance and memory leak audit
status: closed
created-at: 2026-03-01T13:40:25.452102+01:00
closed-at: 2026-03-01T13:47:17.31157+01:00
outcome: Completed full static audit for memory/CPU regressions. Highest-risk issues are event-listener leaks in FileViewerModal/TapestryView and stale server maps in session lifecycle. Also identified high-churn render/update paths and unbounded client caches likely to trigger Safari significant-memory reloads in long sessions.
---

## Comments
**2026-03-01 13:47** — Findings: FileViewerModal document keydown listener leak on repeated show() calls (show->attachDocumentHandlers without detach), TapestryView tooltip DOM leak on dispose, TapestryView static modal keydown listener leak, server previousSessions map not pruning removed local sessions, remote session removal not cleaning remoteActivities/remoteLastActivity/remoteGitStatuses, unbounded PDF/image warm caches, and data-URL binary path causing large memory spikes in Safari.
