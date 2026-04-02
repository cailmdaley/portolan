---
title: 'Hexarchy Gotchas: critical bugs and non-obvious behaviors'
status: closed
tags:
    - '[docs]'
depends-on:
    - hexarchy-overview-spatial-map
created-at: 2026-01-25T15:26:43.748618+01:00
closed-at: 2026-01-31T00:56:53.312613+01:00
---

(hexarchy-gotchas-critical-bugs)=
Critical issues that have caused bugs. Check here first when debugging.

## Hex Positions

**Worker positions must be absolute.** `CityManager.assignWorkerHex()` returns positions relative to (0,0). `buildState()` must offset by city position or workers from different cities overlap at origin.

## Kitty Integration

**Launch needs `--cwd`**: Include `--cwd=${session.cwd}` or terminal starts in wrong directory.

**Focus needs exact match**: Use regex anchors `^session$` to avoid "loom" matching "loom remote".

**Tabs need SSH_AUTH_SOCK**: Kitty tabs don't inherit SSH agent:
```typescript
const sshAuthSock = process.env.SSH_AUTH_SOCK ? `--env SSH_AUTH_SOCK=${shellEscape(process.env.SSH_AUTH_SOCK)}` : '';
```

**Local tabs lose title**: Use tmux even locally for title stability.

## Shell Escaping

**Avoid nested `shellEscape()`** — creates quote soup:
```typescript
// WRONG
const tmux = `... 'bash -l -c ${shellEscape(cmd)}'`;

// RIGHT — double quotes for inner
const tmux = `... 'bash -l -c "felt on ${fiberId} && claude"'`;
```

## File Handling

**Binary files need base64 data URL**: PDFs/images can't be UTF-8. HttpApi returns `data:mime;base64,...`.

**Remote search is filename-only**: Content search disabled (too slow over SSH).

**Parallel searches need distinct cancellation**: Server cancels by searchId prefix. Frontend sends `cityId-1-name` and `cityId-1-content` simultaneously.

## Testing

**Mocks must include all child_process functions**: When adding code that uses `execFile` etc., add to mock or tests fail.

## Felt

**`felt add` returns plain text**: Despite `--json` flag, just returns fiber ID as text. Don't JSON.parse().
