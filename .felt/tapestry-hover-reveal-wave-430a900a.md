---
title: 'Tapestry hover: reveal wave + tooltip both at 300ms'
tags:
    - portolan
depends-on:
    - pyramid-tapestry-tiered-264195af
created-at: 2026-02-22T03:29:14.39203+01:00
outcome: 'Hover on any node triggers after 300ms: (1) full radial reveal animation via expandedNodes + updateTierVisibility(true) and (2) tooltip showing body lead + HR + outcome. Mouseleave cancels timer and collapses hover-expanded nodes. Click during hover makes expansion permanent (hoverExpandedId cleared, mouseleave skips collapse). leadParagraph() strips markdown, returns first 1-2 sentences.'
---
