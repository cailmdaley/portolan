import unittest

from reminders_bridge.eventkit_store import EventKitUnavailable, _date_components_to_iso


class Components:
    def __init__(self, year, month, day, hour=9223372036854775807, minute=9223372036854775807):
        self._year = year
        self._month = month
        self._day = day
        self._hour = hour
        self._minute = minute

    def year(self):
        return self._year

    def month(self):
        return self._month

    def day(self):
        return self._day

    def hour(self):
        return self._hour

    def minute(self):
        return self._minute


class NeverCompletesEventStore:
    def predicateForRemindersInCalendars_(self, calendars):
        return object()

    def fetchRemindersMatchingPredicate_completion_(self, predicate, completion):
        return None


class EventKitStoreUnitTest(unittest.TestCase):
    def test_date_components_preserve_time_when_present(self):
        self.assertEqual(_date_components_to_iso(Components(2026, 5, 20)), "2026-05-20")
        self.assertEqual(_date_components_to_iso(Components(2026, 5, 20, 9, 30)), "2026-05-20T09:30")

    def test_fetch_timeout_is_error_not_empty_success(self):
        from reminders_bridge.eventkit_store import EventKitReminderStore

        store = object.__new__(EventKitReminderStore)
        store.store = NeverCompletesEventStore()
        store.calendar = object()
        store.LIST_TIMEOUT_SECONDS = 0.01

        with self.assertRaises(EventKitUnavailable):
            store.list_reminders()


if __name__ == "__main__":
    unittest.main()
