---
title: Extract Kitty handoff runtime
status: closed
created-at: 2026-03-11T20:04:32.844024+01:00
closed-at: 2026-03-11T21:52:19.216364+01:00
outcome: Extracted Kitty fiber-handoff session bootstrapping into KittyHandoff.ts and moved shell/path helpers into ShellPathUtils.ts so KittyIntegration.ts no longer owns the delayed handoff runtime or shared quoting utilities.
---
