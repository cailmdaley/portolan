---
title: 'CSS specificity gotcha: context rules override class selectors for inline code'
tags:
    - portolan
depends-on:
    - inline-code-path-detection
created-at: 2026-02-20T02:16:48.93793+01:00
outcome: 'Both .tapestry-detail-body code and .file-viewer-markdown code set color: var(--ink-body) — more specific than bare class selectors like .config-resolved or .md-inline-code[title]. Fix: add qualified selectors (.tapestry-detail-body .config-resolved, .file-viewer-markdown .config-resolved, etc.) that match or exceed context rule specificity. Pattern recurs wherever markdown is rendered inside a named container — always check that color overrides use matching or higher specificity.'
---

(css-specificity-gotcha-context)=
# CSS specificity gotcha: context rules override class selectors for inline code
