import unittest

from reminders_bridge.converter import fiber_to_reminder_spec
from reminders_bridge.model import FiberRecord, ReminderRecord
from reminders_bridge.reconcile import apply_plan, build_plan


class FakeStore:
    def __init__(self):
        self.created = []
        self.updated = []
        self.completed = []

    def create_reminder(self, spec):
        self.created.append(spec)

    def update_reminder(self, reminder, spec):
        self.updated.append((reminder, spec))

    def complete_reminder(self, reminder, reason):
        self.completed.append((reminder, reason))


class ReconcileTest(unittest.TestCase):
    def test_creates_updates_completes_and_leaves_unchanged(self):
        unchanged_fiber = FiberRecord(id="same", name="Same", status="open")
        unchanged_spec = fiber_to_reminder_spec(unchanged_fiber)
        stale = ReminderRecord(fiber_id="stale", title="Stale", notes="<!-- fid: stale -->")
        orphan = ReminderRecord(fiber_id=None, title="Manual", notes="")
        plan = build_plan(
            [
                unchanged_fiber,
                FiberRecord(id="new", name="New", status="open"),
                FiberRecord(id="changed", name="Changed", status="active", outcome="fresh"),
            ],
            [
                ReminderRecord(fiber_id="same", title="Same", notes=unchanged_spec.notes, url=unchanged_spec.url),
                ReminderRecord(fiber_id="changed", title="Old", notes="<!-- fid: changed -->"),
                stale,
                orphan,
            ],
        )

        self.assertEqual([spec.fiber_id for spec in plan.create], ["new"])
        self.assertEqual([spec.fiber_id for _, spec in plan.update], ["changed"])
        self.assertEqual([reminder.fiber_id for reminder in plan.complete], ["stale"])
        self.assertEqual([reminder.title for reminder in plan.orphan_complete], ["Manual"])

        store = FakeStore()
        result = apply_plan(store, plan)
        self.assertEqual(result.created, 1)
        self.assertEqual(result.updated, 1)
        self.assertEqual(result.completed, 2)

    def test_completed_matching_reminder_is_reopened_not_duplicated(self):
        plan = build_plan(
            [FiberRecord(id="same", name="Same", status="open")],
            [ReminderRecord(fiber_id="same", title="Same", notes="<!-- fid: same -->", completed=True)],
        )

        self.assertEqual(plan.create, ())
        self.assertEqual([spec.fiber_id for _, spec in plan.update], ["same"])
        store = FakeStore()
        result = apply_plan(store, plan)
        self.assertEqual(result.created, 0)
        self.assertEqual(result.updated, 1)

    def test_completed_stale_and_orphan_reminders_are_left_alone(self):
        plan = build_plan(
            [],
            [
                ReminderRecord(fiber_id="stale", title="Stale", notes="<!-- fid: stale -->", completed=True),
                ReminderRecord(fiber_id=None, title="Manual", notes="", completed=True),
            ],
        )

        self.assertEqual(plan.complete, ())
        self.assertEqual(plan.orphan_complete, ())


if __name__ == "__main__":
    unittest.main()
