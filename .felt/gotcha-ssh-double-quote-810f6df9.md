---
title: 'Gotcha: SSH double-quote wrapping allows shell injection from user content'
status: closed
kind: decision
priority: 2
depends-on:
    - claims-annotation-inline-bba0fc30
created-at: 2026-02-07T05:04:26.933742+01:00
closed-at: 2026-02-07T05:04:34.451001+01:00
close-reason: 'SSH commands wrapping shell strings in double quotes (ssh host "cmd ''arg''") are vulnerable: if arg contains double quotes, they close the outer wrapping and enable injection. Fix: use execFileAsync/execFileSync(''ssh'', [host, cmd]) which bypasses local shell entirely — the command string is interpreted only by the remote shell. Applied to promote-to-felt, file-as-fiber, send-annotations, and send-message handlers. For the inner command, single-quote escaping (replace '' with ''\'''''') remains correct since the remote shell interprets it directly.'
---
