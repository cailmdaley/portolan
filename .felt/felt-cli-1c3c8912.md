---
title: Felt CLI
tags:
    - tapestry:portolan
depends-on:
    - tapestry-structure-4401c64b
created-at: 2026-02-21T19:11:18.430866+01:00
outcome: The felt CLI creates, edits, comments on, and queries fibers. It writes markdown files to .felt/ with YAML frontmatter — the DAG is just a directory of plain text.
---

The `felt` command-line tool manages fibers as markdown files in a project's `.felt/` directory. Each fiber is a single `.md` file with YAML frontmatter (title, status, kind, tags, depends-on, outcome) and a markdown body. The filename doubles as the fiber ID — e.g., `fiber-lifecycle-e188ac24.md` has ID `fiber-lifecycle-e188ac24`.

Core commands: `felt add "Title"` creates a new fiber, `felt edit <id>` modifies frontmatter fields, `felt comment <id> "text"` appends timestamped notes, and `felt close <id> -o "outcome"` marks it resolved. `felt ls` lists fibers with filtering by tag (`-t`), status (`-s`), and kind. `felt upstream <id>` and `felt downstream <id>` walk dependency edges.

The `-a <parent-id>` flag on `felt add` sets `depends-on`, connecting the new fiber into the DAG. Tags are YAML lists in frontmatter. The `tapestry:` prefix selects fibers into a named tapestry view; other tags are freeform. Because fibers are plain text files, they can be read, grepped, and version-controlled with standard tools — felt is a convenience layer, not a database.
