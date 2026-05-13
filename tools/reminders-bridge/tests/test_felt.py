import os
import stat
import tempfile
import textwrap
import unittest
from pathlib import Path

from reminders_bridge.felt import FeltClient


class FeltClientTest(unittest.TestCase):
    def test_exclude_roots_are_hidden_from_felt_commands(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = root / "loom"
            (store / ".felt" / "ai-futures" / "example").mkdir(parents=True)
            (store / ".felt" / "wedding").mkdir()

            fake_felt = root / "felt"
            fake_felt.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env python3
                    import json
                    import sys
                    from pathlib import Path

                    cwd = Path(sys.argv[sys.argv.index("-C") + 1])
                    if (cwd / ".felt" / "wedding").exists():
                        print("wedding root should have been excluded", file=sys.stderr)
                        raise SystemExit(11)
                    if "ls" in sys.argv:
                        print(json.dumps([{
                            "id": "ai-futures/example",
                            "name": "Example",
                            "status": sys.argv[-1],
                        }]))
                    elif "show" in sys.argv:
                        print("Body start line: 5\\n\\nExample body")
                    """
                )
            )
            fake_felt.chmod(fake_felt.stat().st_mode | stat.S_IXUSR)

            fibers = FeltClient(store, str(fake_felt), ("wedding",)).list_open_fibers()

        self.assertEqual([fiber.id for fiber in fibers], ["ai-futures/example"])
        self.assertEqual(fibers[0].body, "Example body")


if __name__ == "__main__":
    unittest.main()
