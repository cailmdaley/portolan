import unittest

from reminders_bridge.converter import extract_fid, fiber_to_reminder_spec, first_body_paragraph, path_tokens
from reminders_bridge.model import FiberRecord


class ConverterTest(unittest.TestCase):
    def test_fiber_to_reminder_spec_maps_core_fields(self):
        spec = fiber_to_reminder_spec(
            FiberRecord(
                id="ai-futures/portolan/vellum-reader/foo",
                name="Foo fiber",
                status="open",
                tags=("portolan", "needs_review", "[life]"),
                outcome="First line\nsecond line",
                due="2026-05-20",
                horizon="soon",
                body="# Heading\n\nThis is the lede.\n\nLater material.",
                file_url="file:///tmp/foo.md",
            )
        )

        self.assertEqual(spec.title, "Foo fiber")
        self.assertEqual(spec.due, "2026-05-20")
        self.assertEqual(spec.url, "file:///tmp/foo.md")
        self.assertIn("-> First line second line", spec.notes)
        self.assertIn("This is the lede.", spec.notes)
        self.assertIn(
            "#fiber #fid-ai-futures-portolan-vellum-reader-foo #portolan #needs-review #life "
            "#h-soon #path-portolan #path-vellum-reader",
            spec.notes,
        )
        self.assertEqual(extract_fid(spec.notes), "ai-futures/portolan/vellum-reader/foo")

    def test_first_body_paragraph_skips_headings_and_code(self):
        body = "# Heading\n\n```txt\nnope\n```\n\nReal first paragraph\nwraps here."
        self.assertEqual(first_body_paragraph(body), "Real first paragraph wraps here.")

    def test_path_tokens_skip_umbrella_root(self):
        self.assertEqual(path_tokens("ai-futures/portolan/foo/bar"), ("portolan", "foo"))


if __name__ == "__main__":
    unittest.main()
