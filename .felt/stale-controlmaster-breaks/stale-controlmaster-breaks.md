---
title: Stale ControlMaster breaks reconnectTunnel
tags:
    - gotcha
depends-on:
    - gotcha-ssh-remoteforward-port
created-at: 2026-03-24T16:43:34.762021+01:00
outcome: 'reconnectTunnel was doing ssh -fN which silently multiplexed through the dead ControlMaster — the RemoteForward never re-established. Fixed: ssh -O exit first (kill master), wait 1s, then ssh -fN. Also integrated tunnel reset into /activate-city so clicking a dormant remote city resets the tunnel before checking/starting the agent. Two reconnect paths now: (1) auto — handleAgentDisconnect fires on WS close, (2) manual — click dormant city triggers activation with tunnel reset.'
---

(stale-controlmaster-breaks)=
# Stale ControlMaster breaks reconnectTunnel
