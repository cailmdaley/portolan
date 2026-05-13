from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

from .dry_run_store import EmptyDryRunStore
from .eventkit_store import EventKitReminderStore
from .felt import FeltClient
from .reconcile import apply_plan, build_plan


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    configure_logging(args.log_file)
    logger = logging.getLogger("reminders_bridge")

    try:
        fibers = FeltClient(args.felt_store, args.felt_bin, tuple(args.exclude_root)).list_open_fibers(
            include_body=not args.no_body,
            limit=args.limit,
        )
        store = EmptyDryRunStore() if args.offline else EventKitReminderStore(args.calendar)
        reminders = store.list_reminders()
        plan = build_plan(fibers, reminders)

        logger.info("sync plan: %s", plan.summary())
        for warning in plan.warnings:
            logger.warning(warning)
        if args.dry_run:
            print_plan(plan)
            return 0

        result = apply_plan(store, plan)
        logger.info(
            "sync applied: created=%d updated=%d completed=%d unchanged=%d warnings=%d",
            result.created,
            result.updated,
            result.completed,
            result.unchanged,
            len(result.warnings),
        )
        return 0
    except Exception as exc:
        logger.exception("sync failed: %s", exc)
        return 1


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Mirror open felt fibers into Apple Reminders")
    parser.add_argument("--felt-store", type=Path, default=Path.home() / "loom")
    parser.add_argument("--felt-bin", default="felt")
    parser.add_argument(
        "--exclude-root",
        action="append",
        default=[],
        help="skip a top-level .felt root while reading the store; repeatable",
    )
    parser.add_argument("--calendar", default="Fibers")
    parser.add_argument("--dry-run", action="store_true", help="print the diff plan without writing reminders")
    parser.add_argument(
        "--offline",
        action="store_true",
        help="avoid EventKit and plan against an empty reminders list; useful for smoke tests",
    )
    parser.add_argument("--no-body", action="store_true", help="skip per-fiber body lookups")
    parser.add_argument("--limit", type=int, help="limit fiber reads for local smoke tests")
    parser.add_argument("--log-file", type=Path)
    return parser.parse_args(argv)


def configure_logging(log_file: Path | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stderr)]
    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        handlers.append(logging.FileHandler(log_file))
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
    )


def print_plan(plan) -> None:
    print(plan.summary())
    for spec in plan.create[:20]:
        print(f"CREATE   {spec.fiber_id} :: {spec.title}")
    for reminder, spec in plan.update[:20]:
        print(f"UPDATE   {spec.fiber_id} :: {reminder.title!r} -> {spec.title!r}")
    for reminder in plan.complete[:20]:
        print(f"COMPLETE {reminder.fiber_id} :: {reminder.title}")
    for reminder in plan.orphan_complete[:20]:
        print(f"COMPLETE orphan :: {reminder.title}")
    if len(plan.create) + len(plan.update) + len(plan.complete) + len(plan.orphan_complete) > 80:
        print("... output truncated to first 20 entries per action")


if __name__ == "__main__":
    raise SystemExit(main())
