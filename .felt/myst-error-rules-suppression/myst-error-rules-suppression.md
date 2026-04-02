---
title: MyST error_rules suppression
tags:
    - decision
    - felt
    - myst
created-at: 2026-04-01T15:37:30.622783+02:00
outcome: 'MyST warns on unknown frontmatter keys (status, depends-on, etc). Two options: (A) namespace under options: key (MyST''s intended mechanism), (B) error_rules in myst.yml to suppress valid-page-frontmatter. Chose B for now — zero code changes, one line in myst.yml. Option A is cleaner long-term but requires restructuring felt''s marshal/parse.'
---

(myst-error-rules-suppression)=
# MyST error_rules suppression
