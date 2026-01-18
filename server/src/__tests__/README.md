# Server Integration Tests

Unit tests for the hexarchy-v2 server components, verifying edge cases from the spec.

## Test Coverage

### CityManager.test.ts
- City creation with explicit and auto-assigned positions
- Position validation (minimum 3-tile spacing)
- City removal and cleanup
- Path matching with longest prefix algorithm
- Nested path handling (e.g., `/project` vs `/project/subproject`)
- Partial directory name rejection (e.g., `/project` doesn't match `/project-other`)
- Worker hex assignment in spiral order
- Worker hex release and reuse
- City sorting by name

### FiberReader.test.ts
- Counting open fibers from .felt directory
- Handling missing .felt directories
- Parsing various frontmatter status values
- Graceful handling of:
  - Missing status fields
  - Missing frontmatter
  - Malformed YAML
  - Non-.md files
  - Unreadable files
- Status value edge cases (quotes, whitespace, multiple delimiters)

### SessionTracker.test.ts
- Session discovery from tmux output
- Parsing tmux list-panes format
- Filtering sessions running Claude (via pgrep)
- Change detection:
  - Sessions added
  - Sessions removed
  - Working directory changes
- Handling edge cases:
  - tmux not running
  - Malformed tmux output
  - Empty output
  - Rapid session creation/deletion
- Stable session ID generation

## Running Tests

```bash
npm test              # Run all tests
npm test -- --watch   # Watch mode
npm test -- --coverage # Coverage report
```

## Notes

- CityManager tests save/restore real cities to avoid interfering with the user's actual hexarchy state
- Tests use `/tmp/` paths for isolation
- SessionTracker tests mock child_process.exec to avoid spawning real tmux processes
