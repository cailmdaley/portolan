---
title: MyST frontmatter and slug limits
status: closed
created-at: 2026-04-01T21:55:14.298765+02:00
closed-at: 2026-04-01T21:57:56.818593+02:00
outcome: 'Verified MyST v1.8.3 suppresses custom fiber frontmatter warnings via project.error_rules.valid-page-frontmatter=ignore; namespacing under felt: still warns. Current felt repo ships that default, but existing .felt/myst.yml files are not upgraded. Slug truncation is correct for ASCII word-boundary cases but not Unicode-safe because slugify preserves non-ASCII while GenerateID/truncateAtWord slice by bytes; collision suffixes can also push final IDs past 32 chars.'
---

(myst-frontmatter-and-slug-limits)=
# MyST frontmatter and slug limits
