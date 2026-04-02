---
title: portolan depends_on mapping assumed bare strings
tags:
    - decision
created-at: 2026-02-12T00:22:48.226306+01:00
outcome: 'felt emits depends_on as [{id: ...}] objects but portolan mapped them straight to string[]. Edge comparisons always failed — 0 links. Fix: map d => typeof d === string ? d : d.id'
---

(portolan-depends-on-mapping)=
# portolan depends_on mapping assumed bare strings
