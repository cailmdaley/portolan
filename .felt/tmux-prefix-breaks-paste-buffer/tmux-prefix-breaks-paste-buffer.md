---
title: tmux = prefix breaks paste-buffer on 2.7
tags:
    - portolan
    - gotcha
depends-on:
    - candide-tmux-2-7-incompatible
created-at: 2026-03-23T10:00:24.34466+01:00
outcome: 'tmux exact-match prefix (=session) for -t targets doesn''t work on tmux 2.7 (candide). paste-buffer -t ''=slides'' fails with ''can''t find pane''. Works fine without the prefix. Fixed: remote annotation send path uses bare shellEscape(session) instead of exactTmuxTarget(session). Local still uses = for safety.'
---

(tmux-prefix-breaks-paste-buffer)=
# tmux = prefix breaks paste-buffer on 2.7
