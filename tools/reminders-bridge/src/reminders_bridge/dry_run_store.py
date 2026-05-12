from __future__ import annotations

from .model import ReminderRecord, ReminderSpec


class EmptyDryRunStore:
    def list_reminders(self) -> list[ReminderRecord]:
        return []

    def create_reminder(self, spec: ReminderSpec) -> None:
        pass

    def update_reminder(self, reminder: ReminderRecord, spec: ReminderSpec) -> None:
        pass

    def complete_reminder(self, reminder: ReminderRecord, reason: str) -> None:
        pass
