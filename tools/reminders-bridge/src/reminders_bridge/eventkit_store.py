from __future__ import annotations

import threading
from datetime import datetime
from pathlib import Path

from .converter import extract_fid
from .model import ReminderRecord, ReminderSpec


class EventKitUnavailable(RuntimeError):
    pass


class EventKitReminderStore:
    LIST_TIMEOUT_SECONDS = 30
    ACCESS_TIMEOUT_SECONDS = 60

    def __init__(self, calendar_name: str):
        try:
            import EventKit  # type: ignore
            import Foundation  # type: ignore
        except ImportError as exc:
            raise EventKitUnavailable(
                "pyobjc-framework-EventKit is not installed; run scripts/install-reminders-bridge.sh"
            ) from exc

        self.EventKit = EventKit
        self.Foundation = Foundation
        self.store = EventKit.EKEventStore.alloc().init()
        self._request_access()
        self.calendar = self._calendar(calendar_name)

    def list_reminders(self) -> list[ReminderRecord]:
        predicate = self.store.predicateForRemindersInCalendars_([self.calendar])
        done = threading.Event()
        result: list[object] = []

        def completion(reminders):
            result.extend(reminders or [])
            done.set()

        self.store.fetchRemindersMatchingPredicate_completion_(predicate, completion)
        if not done.wait(self.LIST_TIMEOUT_SECONDS):
            raise EventKitUnavailable("timed out fetching reminders from EventKit")
        return [self._record(reminder) for reminder in result]

    def create_reminder(self, spec: ReminderSpec) -> None:
        reminder = self.EventKit.EKReminder.reminderWithEventStore_(self.store)
        reminder.setCalendar_(self.calendar)
        self._apply_spec(reminder, spec)
        self._save_reminder(reminder)

    def update_reminder(self, reminder: ReminderRecord, spec: ReminderSpec) -> None:
        if reminder.raw is None:
            raise EventKitUnavailable("cannot update reminder without raw EventKit object")
        self._apply_spec(reminder.raw, spec)
        self._save_reminder(reminder.raw)

    def complete_reminder(self, reminder: ReminderRecord, reason: str) -> None:
        if reminder.raw is None:
            return
        notes = reminder.notes or ""
        if reason not in notes:
            notes = f"{notes}\n\n[{reason}]".strip()
            reminder.raw.setNotes_(notes)
        reminder.raw.setCompleted_(True)
        self._save_reminder(reminder.raw)

    def _request_access(self) -> None:
        done = threading.Event()
        state: dict[str, object] = {"granted": False, "error": None}

        def completion(granted, error):
            state["granted"] = bool(granted)
            state["error"] = error
            done.set()

        if hasattr(self.store, "requestFullAccessToRemindersWithCompletion_"):
            self.store.requestFullAccessToRemindersWithCompletion_(completion)
        else:
            self.store.requestAccessToEntityType_completion_(self.EventKit.EKEntityTypeReminder, completion)

        if not done.wait(self.ACCESS_TIMEOUT_SECONDS):
            raise PermissionError("Reminders access request timed out")
        if not state["granted"]:
            raise PermissionError(f"Reminders access denied: {state['error']}")

    def _calendar(self, name: str):
        for calendar in self.store.calendarsForEntityType_(self.EventKit.EKEntityTypeReminder):
            if str(calendar.title()) == name:
                return calendar

        calendar = self.EventKit.EKCalendar.calendarForEntityType_eventStore_(
            self.EventKit.EKEntityTypeReminder,
            self.store,
        )
        calendar.setTitle_(name)
        calendar.setSource_(self._icloud_source())
        self._save_calendar(calendar)
        return calendar

    def _icloud_source(self):
        sources = list(self.store.sources())
        caldav_type = getattr(self.EventKit, "EKSourceTypeCalDAV", None)
        for source in sources:
            title = str(source.title()).lower()
            if "icloud" in title:
                return source
        if caldav_type is not None:
            for source in sources:
                if source.sourceType() == caldav_type:
                    return source
        if not sources:
            raise EventKitUnavailable("no EventKit sources available for Reminders")
        return sources[0]

    def _record(self, reminder) -> ReminderRecord:
        return ReminderRecord(
            fiber_id=extract_fid(str(reminder.notes() or "")),
            title=str(reminder.title() or ""),
            notes=str(reminder.notes() or ""),
            due=_date_components_to_iso(reminder.dueDateComponents()),
            url=str(reminder.URL().absoluteString()) if reminder.URL() else None,
            priority=int(reminder.priority() or 0),
            completed=bool(reminder.isCompleted()),
            raw=reminder,
        )

    def _apply_spec(self, reminder, spec: ReminderSpec) -> None:
        reminder.setTitle_(spec.title)
        reminder.setNotes_(spec.notes)
        reminder.setCompleted_(False)
        reminder.setPriority_(int(spec.priority or 0))
        reminder.setDueDateComponents_(_iso_to_date_components(self.Foundation, spec.due))
        if spec.url:
            reminder.setURL_(self.Foundation.NSURL.URLWithString_(spec.url))
        for path in spec.attachments:
            self._add_attachment(reminder, path)

    def _add_attachment(self, reminder, path: Path) -> None:
        attachment_class = getattr(self.EventKit, "EKAttachment", None)
        if attachment_class is None or not hasattr(reminder, "addAttachment_"):
            return
        factory = getattr(attachment_class, "attachmentWithFilepath_", None)
        if factory is None:
            return
        attachment = factory(str(path))
        if attachment is not None:
            reminder.addAttachment_(attachment)

    def _save_calendar(self, calendar) -> None:
        result = self.store.saveCalendar_commit_error_(calendar, True, None)
        _raise_on_objc_failure(result, "save calendar")

    def _save_reminder(self, reminder) -> None:
        result = self.store.saveReminder_commit_error_(reminder, True, None)
        _raise_on_objc_failure(result, "save reminder")


def _raise_on_objc_failure(result, action: str) -> None:
    if isinstance(result, tuple):
        ok = bool(result[0])
        error = result[1] if len(result) > 1 else None
    else:
        ok = bool(result)
        error = None
    if not ok:
        raise EventKitUnavailable(f"EventKit failed to {action}: {error}")


def _iso_to_date_components(Foundation, value: str | None):
    if not value:
        return None
    parsed = datetime.fromisoformat(value.removesuffix("Z"))
    components = Foundation.NSDateComponents.alloc().init()
    components.setYear_(parsed.year)
    components.setMonth_(parsed.month)
    components.setDay_(parsed.day)
    if "T" in value:
        components.setHour_(parsed.hour)
        components.setMinute_(parsed.minute)
    return components


def _date_components_to_iso(components) -> str | None:
    if components is None:
        return None
    year = components.year()
    month = components.month()
    day = components.day()
    hour = components.hour()
    minute = components.minute()
    if year == 9223372036854775807 or month == 9223372036854775807 or day == 9223372036854775807:
        return None
    date = f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    if hour == 9223372036854775807 or minute == 9223372036854775807:
        return date
    return f"{date}T{int(hour):02d}:{int(minute):02d}"
