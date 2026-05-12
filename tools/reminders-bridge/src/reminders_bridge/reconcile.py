from __future__ import annotations

from collections.abc import Iterable
from typing import Protocol

from .converter import fiber_to_reminder_spec
from .model import ApplyResult, FiberRecord, ReconcilePlan, ReminderRecord, ReminderSpec


class ReminderStore(Protocol):
    def list_reminders(self) -> list[ReminderRecord]: ...
    def create_reminder(self, spec: ReminderSpec) -> None: ...
    def update_reminder(self, reminder: ReminderRecord, spec: ReminderSpec) -> None: ...
    def complete_reminder(self, reminder: ReminderRecord, reason: str) -> None: ...


def build_plan(open_fibers: Iterable[FiberRecord], reminders: Iterable[ReminderRecord]) -> ReconcilePlan:
    specs = {fiber.id: fiber_to_reminder_spec(fiber) for fiber in open_fibers}
    reminder_index: dict[str, ReminderRecord] = {}
    warnings: list[str] = []
    orphan_complete: list[ReminderRecord] = []

    for reminder in reminders:
        if reminder.completed:
            continue
        if not reminder.fiber_id:
            orphan_complete.append(reminder)
            continue
        if reminder.fiber_id in reminder_index:
            warnings.append(f"duplicate reminder for {reminder.fiber_id}; leaving duplicate unchanged")
            continue
        reminder_index[reminder.fiber_id] = reminder

    creates: list[ReminderSpec] = []
    updates: list[tuple[ReminderRecord, ReminderSpec]] = []
    unchanged: list[ReminderRecord] = []

    for fiber_id, spec in specs.items():
        reminder = reminder_index.pop(fiber_id, None)
        if reminder is None:
            creates.append(spec)
        elif reminder_matches(reminder, spec):
            unchanged.append(reminder)
        else:
            updates.append((reminder, spec))

    completes = list(reminder_index.values())
    return ReconcilePlan(
        create=tuple(creates),
        update=tuple(updates),
        complete=tuple(completes),
        unchanged=tuple(unchanged),
        orphan_complete=tuple(orphan_complete),
        warnings=tuple(warnings),
    )


def apply_plan(store: ReminderStore, plan: ReconcilePlan) -> ApplyResult:
    result = ApplyResult(unchanged=len(plan.unchanged), warnings=list(plan.warnings))
    for spec in plan.create:
        store.create_reminder(spec)
        result.created += 1
    for reminder, spec in plan.update:
        store.update_reminder(reminder, spec)
        result.updated += 1
    for reminder in plan.complete:
        store.complete_reminder(reminder, "fiber closed or no longer open")
        result.completed += 1
    for reminder in plan.orphan_complete:
        store.complete_reminder(reminder, "fiber marker missing")
        result.completed += 1
    return result


def reminder_matches(reminder: ReminderRecord, spec: ReminderSpec) -> bool:
    return (
        reminder.title == spec.title
        and (reminder.notes or "") == spec.notes
        and reminder.due == spec.due
        and reminder.url == spec.url
        and reminder.priority == spec.priority
    )
