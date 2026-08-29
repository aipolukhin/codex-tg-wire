import io
import importlib.util
import json
import sys
import tempfile
import threading
import unittest
from dataclasses import dataclass
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest.mock import patch


REPO_ROOT = Path(__file__).resolve().parents[1]
SUPERVISOR_PATH = REPO_ROOT / "scripts" / "dashi-channel-supervisor"


def load_supervisor():
    module_name = "dashi_channel_supervisor"
    loader = SourceFileLoader(module_name, str(SUPERVISOR_PATH))
    spec = importlib.util.spec_from_loader(module_name, loader)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    loader.exec_module(module)
    return module


@dataclass
class FakeCompleted:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class FakeRunner:
    def __init__(self, responses=None):
        self.responses = responses or {}
        self.commands = []

    def run(self, command, capture=True):
        self.commands.append((tuple(command), capture))
        key = tuple(command)
        if key in self.responses:
            return self.responses[key]
        return FakeCompleted(0)

    def command_names(self):
        return [" ".join(command) for command, _capture in self.commands]


class SupervisorTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.runtime_root = Path(self.tmp.name) / "channel-runtime"
        self.secret_value = "123456:DO_NOT_PRINT_THIS_TEST_TOKEN"
        token_path = self.runtime_root / "canary" / "secrets" / "telegram-bot-token"
        token_path.parent.mkdir(parents=True)
        token_path.write_text(self.secret_value, encoding="utf-8")
        self.env = {"DASHI_CHANNEL_RUNTIME_ROOT": str(self.runtime_root)}

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, args, runner):
        supervisor = load_supervisor()
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = supervisor.main(args, env=self.env, runner=runner, stdout=stdout, stderr=stderr)
        return code, stdout.getvalue(), stderr.getvalue(), runner

    def test_status_canary_initializes_runtime_without_secret_output(self):
        runner = FakeRunner(
            {
                ("tmux", "has-session", "-t", "dashi-canary"): FakeCompleted(1, stderr="missing")
            }
        )

        code, out, err, _runner = self.run_cli(["status", "canary", "--json"], runner)

        self.assertEqual(code, 0)
        status = json.loads(out)
        self.assertEqual(status["agent"], "canary")
        self.assertEqual(status["session"], "dashi-canary")
        self.assertEqual(status["state"], "missing")
        self.assertFalse(status["tmux"]["exists"])
        self.assertTrue((self.runtime_root / "canary" / "metadata.json").exists())
        self.assertTrue((self.runtime_root / "canary" / "logs").is_dir())
        self.assertTrue((self.runtime_root / "canary" / "queue").is_dir())
        self.assertNotIn(self.secret_value, out + err)

    def test_concurrent_layout_initialization_does_not_race_metadata_write(self):
        supervisor = load_supervisor()
        profile = supervisor.canary_profile(self.env)
        barrier = threading.Barrier(2)
        errors = []
        original_write_text = Path.write_text

        def slowed_write_text(path, *args, **kwargs):
            result = original_write_text(path, *args, **kwargs)
            if path.parent == profile.agent_root and path.name.startswith(".metadata.json"):
                barrier.wait(timeout=5)
            return result

        def initialize_layout():
            try:
                supervisor.ensure_canary_layout(profile)
            except Exception as exc:  # pragma: no cover - assertion reports details
                errors.append(exc)

        with patch.object(Path, "write_text", slowed_write_text):
            threads = [threading.Thread(target=initialize_layout) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

        self.assertEqual(errors, [])
        self.assertTrue(profile.metadata_path.exists())

    def test_logs_prints_paths_without_dumping_token_or_log_contents_by_default(self):
        log_dir = self.runtime_root / "canary" / "logs"
        log_dir.mkdir(parents=True)
        (log_dir / "stdout.log").write_text(f"leaked {self.secret_value}\n", encoding="utf-8")
        runner = FakeRunner()

        code, out, err, _runner = self.run_cli(["logs", "canary"], runner)

        self.assertEqual(code, 0)
        self.assertIn("stdout:", out)
        self.assertIn("stderr:", out)
        self.assertIn("supervisor:", out)
        self.assertNotIn("leaked", out)
        self.assertNotIn(self.secret_value, out + err)

    def test_attach_refuses_missing_session_without_creating_it(self):
        runner = FakeRunner(
            {
                ("tmux", "has-session", "-t", "dashi-canary"): FakeCompleted(1, stderr="missing")
            }
        )

        code, out, err, runner = self.run_cli(["attach", "canary"], runner)

        self.assertNotEqual(code, 0)
        self.assertIn("does not exist", err)
        self.assertNotIn("Ctrl-b d", out)
        self.assertEqual(runner.command_names(), ["tmux has-session -t dashi-canary"])

    def test_attach_existing_session_prints_detach_instruction_before_attach(self):
        runner = FakeRunner(
            {
                ("tmux", "has-session", "-t", "dashi-canary"): FakeCompleted(0),
                ("tmux", "attach-session", "-t", "dashi-canary"): FakeCompleted(0),
            }
        )

        code, out, err, runner = self.run_cli(["attach", "canary"], runner)

        self.assertEqual(code, 0)
        self.assertIn("Detach with Ctrl-b d", out)
        self.assertEqual(
            runner.command_names(),
            [
                "tmux has-session -t dashi-canary",
                "tmux attach-session -t dashi-canary",
            ],
        )
        self.assertNotIn(self.secret_value, out + err)

    def test_start_refuses_when_channel_cli_syntax_is_unconfirmed(self):
        runner = FakeRunner(
            {
                ("claude", "--help"): FakeCompleted(
                    0,
                    stdout="Usage: claude [options]\n  --print\n  --resume <id>\n",
                )
            }
        )

        code, out, err, runner = self.run_cli(["start", "canary", "--json"], runner)

        self.assertNotEqual(code, 0)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["reason"], "channel_cli_unconfirmed")
        self.assertIn("channel CLI syntax", payload["message"])
        commands = runner.command_names()
        self.assertEqual(commands, ["claude --help"])
        self.assertFalse(any("tmux new-session" in command for command in commands))
        self.assertFalse(any("getUpdates" in command for command in commands))
        self.assertNotIn(self.secret_value, out + err)

    def test_non_canary_agents_are_rejected_by_the_scaffold(self):
        runner = FakeRunner()

        code, out, err, runner = self.run_cli(["status", "agent-one", "--json"], runner)

        self.assertNotEqual(code, 0)
        payload = json.loads(out)
        self.assertEqual(payload["status"], "blocked")
        self.assertEqual(payload["reason"], "canary_only")
        self.assertEqual(runner.commands, [])
        self.assertNotIn(self.secret_value, out + err)

    def test_logs_non_canary_error_uses_the_configured_error_stream(self):
        runner = FakeRunner()

        code, out, err, runner = self.run_cli(["logs", "agent-one"], runner)

        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")
        self.assertIn("canary_only", err)
        self.assertEqual(runner.commands, [])


if __name__ == "__main__":
    unittest.main()
