---
title: Cineca Leonardo specific node hostnames
status: closed
kind: spec
priority: 2
created-at: 2026-01-22T15:29:22.011714+01:00
closed-at: 2026-01-22T15:29:31.679586+01:00
close-reason: "Cineca Leonardo HPC specific node external hostnames (from docs.hpc.cineca.it):\n\n- login01-ext.leonardo.cineca.it\n- login02-ext.leonardo.cineca.it  \n- login05-ext.leonardo.cineca.it\n- login07-ext.leonardo.cineca.it\n\n**Pattern:** `login{XX}-ext.leonardo.cineca.it`\n\n**Internal hostnames:** `login{XX}.leonardo.local`\n\n**Usage:** SSH config maps `cineca-loginXX` → `loginXX-ext.leonardo.cineca.it`\n\n**Note:** 2FA mandatory. Uses step SSH certificates (`step ssh login 'user@email' --provisioner cineca-hpc`) which are valid 12 hours and added to SSH agent."
---
