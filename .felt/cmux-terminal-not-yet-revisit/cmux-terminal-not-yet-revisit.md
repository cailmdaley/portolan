---
title: 'cmux terminal: not yet, revisit later'
tags:
    - portolan,question
created-at: 2026-02-21T17:22:33.804873+01:00
outcome: Evaluated manaflow-ai/cmux as potential Kitty replacement. Native macOS terminal (Swift/AppKit) built on libghostty with vertical tabs, notification system, and in-app browser with scriptable API (ported from agent-browser). Socket API is impressive (v2 JSON protocol with stable handles) but only ~3 weeks old. libghostty buys rendering quality and Ghostty config compat, but the orchestration/scripting layer portolan depends on (focus tab, launch tab, match by title) is cmux's own code — not battle-tested. Browser pane integration is the genuine novel draw (tapestry could live inside the terminal), but not worth the early-adopter risk right now. Revisit when socket API has more mileage.
---

(cmux-terminal-not-yet-revisit)=
# cmux terminal: not yet, revisit later
