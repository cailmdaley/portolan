---
title: 'Gotcha: SSH RemoteForward port held by stale sshd after disconnect'
tags:
    - '[portolan]'
    - gotcha
created-at: 2026-02-13T00:45:21.066938+01:00
outcome: 'When internet drops and ControlMaster dies, the sshd child on the remote still holds the RemoteForward port (4004). New SSH connections succeed but ExitOnForwardFailure triggers because the port is already bound. Fix: ssh -O exit, then on remote kill the stale sshd or fuser -k the port, then reconnect. Diagnosis: ''ssh -v ... -o ExitOnForwardFailure=yes'' shows ''remote forward failure for: listen 4004''. ss -tlnp shows LISTEN with no Process (orphaned sshd).'
---

(gotcha-ssh-remoteforward-port)=
# Gotcha: SSH RemoteForward port held by stale sshd after disconnect
