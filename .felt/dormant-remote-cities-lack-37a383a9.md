---
title: Dormant remote cities lack hasClaims
tags:
    - gotcha
depends-on:
    - remote-origin-id-mismatch-0994fb6f
created-at: 2026-03-30T11:11:36.904792+02:00
outcome: 'hasClaims for remote cities is only set when an active Claude session exists in that cwd — the agent reports it per-session. Dormant remote cities (no active worker) never get hasClaims=true, so the tapestry button never appears even though the /tapestry endpoint works fine over SSH. Fixed: pinned remote cities default hasClaims=true in addPinnedCity. The tapestry endpoint handles discovery regardless, and any running agent overrides with the actual value.'
---
