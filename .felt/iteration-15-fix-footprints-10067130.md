---
title: 'Iteration 15: fix footprints + working name glow'
status: closed
kind: task
priority: 2
depends-on:
    - ralph-loop-autonomous-portolan-84bd75bf
created-at: 2026-01-31T21:39:57.614796+01:00
closed-at: 2026-01-31T21:44:40.337611+01:00
close-reason: Fixed footprint visibility (added explicit opacity:1.0 to MeshBasicMaterial). Removed activity banner decals, replaced with golden glow on worker name when status=working. Label now updates when worker status changes. Also closed fiber workers-remove-activity-banners-e777445b. Cleaner visual - workers now just show position dot + name, activity through glow/motion.
---
