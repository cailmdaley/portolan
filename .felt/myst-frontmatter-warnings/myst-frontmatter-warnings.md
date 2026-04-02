---
title: MyST frontmatter warnings
status: closed
created-at: 2026-04-01T12:37:47.923068+02:00
closed-at: 2026-04-01T12:40:55.210704+02:00
outcome: 'MyST page frontmatter is schema-validated against hard-coded top-level fields, so namespacing felt metadata under a top-level felt: key would still be treated as an extra key. Recommend keeping MyST frontmatter limited to MyST-supported fields and moving felt-specific state out of frontmatter; suppression via project.error_rules is only suitable as a temporary migration aid because it disables valid-page-frontmatter checks broadly. GenerateID already caps slugs at 32 bytes/chars in the ASCII case, but slugify currently admits non-ASCII letters while truncation slices by bytes, so slug generation should be made ASCII-only or rune-safe; ASCII-only is preferable for stable file IDs.'
---

(myst-frontmatter-warnings)=
# MyST frontmatter warnings
