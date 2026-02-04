---
title: Kitty socket staleness causes tab creation failure
status: closed
kind: question
priority: 2
created-at: 2026-02-04T01:15:28.527493+01:00
closed-at: 2026-02-04T01:15:28.527496+01:00
close-reason: 'KITTY_LISTEN_ON env var can point to dead socket (e.g. /tmp/kitty-1898) when actual socket is different (e.g. /tmp/kitty-68304). Both focus-tab and launch commands fail silently, only activateKitty() works (AppleScript). Fix: configure stable socket path in kitty.conf (listen_on unix:/tmp/kitty-socket) or restart server from fresh terminal after Kitty restart.'
---
