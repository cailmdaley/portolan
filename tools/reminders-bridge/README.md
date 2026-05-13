# Reminders Bridge

This tool mirrors open and active felt fibers into an Apple Reminders list named
`Fibers`. The mirror is one-way: felt is the source of truth, and each sync
converges Reminders onto the current fiber state.

## Install

```bash
./scripts/install-reminders-bridge.sh
```

The installer creates a Python virtualenv under
`~/.local/share/portolan/reminders-bridge-venv`, installs this package with the
EventKit PyObjC binding, writes
`~/Library/LaunchAgents/com.cailmdaley.portolan-reminders-bridge.plist`, and
starts the job. Logs land at:

```bash
tail -f ~/.local/state/portolan/reminders-bridge.log
```

On the first EventKit run, macOS may ask for Reminders access. Grant full
Reminders access so the launchd job can create and maintain the `Fibers` list.

The installer excludes the top-level `wedding` felt root by default because that
zone is private, iCloud-backed, and launchd may not be allowed to walk it. Add
more skipped top-level roots with `--exclude-root NAME`; use
`--no-default-excludes` only if those private roots should be mirrored too.
If the log then shows `operation not permitted`, grant the launchd executable
chain access in System Settings. The bridge runs Python, which shells out to
`felt`, so the practical fix is to grant Full Disk Access to the Python
interpreter in `~/.local/share/portolan/reminders-bridge-venv/bin/python` and/or
the `felt` binary named in the plist.

## Manual Runs

Dry-run against the real `Fibers` list without writing:

```bash
~/.local/share/portolan/reminders-bridge-venv/bin/python -m reminders_bridge.sync --dry-run
```

Offline smoke that avoids EventKit entirely:

```bash
PYTHONPATH=tools/reminders-bridge/src python -m reminders_bridge.sync --dry-run --offline --limit 5
```

Run one real sync:

```bash
~/.local/share/portolan/reminders-bridge-venv/bin/python -m reminders_bridge.sync
```

## Smart Lists

After the first successful sync, create these smart lists in Reminders.app:

- `Now`: tag `#h-now` and not completed
- `Soon`: tag `#h-soon` or due in the next 14 days
- `All fibers`: tag `#fiber` and not completed
- `Portolan`: tag `#path-portolan` and not completed
- `Lightcone`: tag `#path-lightcone` and not completed
- `Personal`: tag `#path-personal` and not completed

The smart lists sync through iCloud to iPhone, iPad, and Apple Watch.

## Mapping

Each reminder title is the fiber name. The notes contain the current outcome,
the first body paragraph, searchable hashtags, the file or Portolan URL, and a
hidden marker:

```text
<!-- fid: ai-futures/portolan/example -->
```

That marker is the durable identity used on the next reconciliation pass.
EventKit does not expose a stable writable external identifier for Reminders, so
the marker is the primary lookup key.

## Uninstall

```bash
./scripts/install-reminders-bridge.sh --uninstall
```

This unloads and removes the launchd plist. It does not delete the `Fibers`
Reminders list.
