import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]


class InstallScriptTest(unittest.TestCase):
    def test_write_only_renders_launchd_plist(self):
        with tempfile.TemporaryDirectory() as tmp:
            plist_dir = Path(tmp) / "LaunchAgents"
            log_dir = Path(tmp) / "logs"
            venv_dir = Path(tmp) / "venv"
            subprocess.run(
                [
                    str(REPO_ROOT / "scripts" / "install-reminders-bridge.sh"),
                    "--write-only",
                    "--skip-deps",
                    "--plist-dir",
                    str(plist_dir),
                    "--log-dir",
                    str(log_dir),
                    "--venv-dir",
                    str(venv_dir),
                    "--python",
                    "/usr/bin/python3",
                ],
                cwd=REPO_ROOT,
                check=True,
                env={**os.environ, "HOME": str(Path(tmp) / "home")},
            )

            plist = plist_dir / "com.cailmdaley.portolan-reminders-bridge.plist"
            self.assertTrue(plist.exists())
            text = plist.read_text()
            self.assertIn("<integer>300</integer>", text)
            self.assertIn("-m</string>", text)
            self.assertIn("reminders_bridge.sync", text)
            self.assertIn("PYTHONPATH", text)


if __name__ == "__main__":
    unittest.main()
