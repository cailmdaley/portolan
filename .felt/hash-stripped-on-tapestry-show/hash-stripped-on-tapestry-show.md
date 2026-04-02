---
title: Hash stripped on tapestry show
tags:
    - portolan
    - gotcha
depends-on:
    - stable-city-ids
created-at: 2026-03-23T10:00:43.887096+01:00
outcome: 'URL hash (e.g. #fiber-id) was lost when opening tapestry via bookmarked URL. show() called hideDetail() which called pushHash(null) — stripping the hash before showCity() could read it. Fix: capture window.location.hash before hideDetail(), pass it into showCity() as preserveHash parameter.'
---

(hash-stripped-on-tapestry-show)=
# Hash stripped on tapestry show
