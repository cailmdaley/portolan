---
title: Homebrew felt shadowed go binary
tags:
    - gotcha
created-at: 2026-04-01T15:37:49.001974+02:00
outcome: 'go build -o ~/go/bin/felt installed v2 but /opt/homebrew/bin/felt (old v0.2.0 from homebrew tap) took precedence in PATH. Fix: go build -o /opt/homebrew/bin/felt directly. Watch for this when testing dev builds.'
---

(homebrew-felt-shadowed-go-binary)=
# Homebrew felt shadowed go binary
