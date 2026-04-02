---
title: Harden file viewer async ownership and remote binary transport
status: closed
created-at: 2026-03-01T17:05:27.503326+01:00
closed-at: 2026-03-01T17:09:39.034414+01:00
outcome: 'Hardened modal async ownership and remote binary transport. FileViewerModal now owns/cancels rendered-markdown tapestry fetches, clears deferred UI timers on hide/dispose, and guards annotation save/reload against stale completions after navigation/close. HttpApi /file-content binary paths now read remote media via raw ssh cat buffers instead of remote base64 encoding, reducing transient memory overhead and copy amplification. Validation: cd server && npm test; cd server && npm run build; npm run build.'
---

(harden-file-viewer-async)=
# Harden file viewer async ownership and remote binary transport
