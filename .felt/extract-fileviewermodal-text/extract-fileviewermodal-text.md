---
title: Extract FileViewerModal text editor subsystem
status: closed
created-at: 2026-03-10T18:57:41.585851+01:00
closed-at: 2026-03-10T19:07:30.5847+01:00
outcome: Extracted the editable text workspace out of FileViewerModal into src/ui/FileViewerTextEditor.ts. The new controller owns CodeMirror configuration, dirty tracking, markdown edit-mode transitions, save/copy/download actions, and text-file state, while FileViewerModal now coordinates request ownership, modal chrome, navigation keys, and image/PDF/text presentation. Verified with npm run build.
---

(extract-fileviewermodal-text)=
# Extract FileViewerModal text editor subsystem
