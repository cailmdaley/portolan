---
title: 'export: full-path encoding for linked files'
status: closed
tags:
    - portolan
depends-on:
    - export-linked-files-tex-pdf-in
created-at: 2026-02-24T11:27:02.498296+01:00
outcome: 'Linked files (e.g. main.pdf) from tapestry fibers are downloaded to docs/data/<city>/files/. Original code used basename only — multiple fibers linking files with the same name (e.g. two papers/main.pdf) overwrote each other. Two wrong turns: (1) fiber-ID prefix using first 8 chars → ''companio'' collision for related fibers; (2) last 8 chars → still collides if two files in same fiber have same name. Fix: encode full relative path as filename, replacing / with _. papers/companion/main.pdf → papers_companion_main.pdf. Unique by construction.'
---

(export-full-path-encoding-for)=
# export: full-path encoding for linked files
