---
title: 'Entity-specific banner styles: cities vs workers'
status: closed
kind: decision
priority: 2
depends-on:
    - banner-transparency-not-working-f482e3c3
    - 3-slice-banner-labels-with-nano-b797a6b2
created-at: 2026-01-18T19:57:46.901285+01:00
closed-at: 2026-01-18T19:57:55.330207+01:00
close-reason: 'Cities get parchment/cartographic banner (banner.png, blood red text #4A1515, 40px slices). Workers get leather/craftsman banner (worker-banner.png, dark brown text #3D2817, 150px slices to show tool icons). Different aesthetics reinforce the visual hierarchy. sliceWidth parameter in createLabel() controls how much decorative edge shows.'
---
