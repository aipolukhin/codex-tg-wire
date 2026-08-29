"""Structural publication-safety tests for documentation shipped to users.

The checks deliberately avoid embedding old deployment fingerprints in the
test itself. They reject classes of leaks (concrete home directories, private
tailnet addresses and configured Telegram IDs) while allowing clearly fake
examples and documented placeholders.
"""

from __future__ import annotations

import ipaddress
import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

CANARY_SMOKE = REPO_ROOT / "plugin" / "docs" / "canary-smoke.md"

CONCRETE_HOME_RE = re.compile(r"/(?:Users|home)/(?P<user>[A-Za-z0-9._-]+)")
IPV4_RE = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])")
CONFIGURED_TELEGRAM_ID_RE = re.compile(
    r"TELEGRAM_(?:EXPECTED_BOT_ID|ALLOWED_USER_IDS|ALLOWED_CHAT_IDS)\s*=\s*-?\d{6,}"
)

# Files in scope for this safety check. Extend as more public runbooks land.
PUBLIC_DOCS = (CANARY_SMOKE,)

# Lower bound on file size. Sanitization must not collapse the runbook into
# a stub — it has value as a public smoke-test template only if it stays
# substantive.
MIN_BYTES = 500


class PublicDocsExistTest(unittest.TestCase):
    """Sanitization should not delete the file outright."""

    def test_canary_smoke_exists(self) -> None:
        self.assertTrue(
            CANARY_SMOKE.exists(),
            f"{CANARY_SMOKE} missing — sanitization should rewrite, not delete.",
        )

    def test_canary_smoke_non_trivial(self) -> None:
        size = CANARY_SMOKE.stat().st_size
        self.assertGreater(
            size,
            MIN_BYTES,
            f"{CANARY_SMOKE} is only {size} bytes; expected > {MIN_BYTES}. "
            "Sanitization should not strip the runbook down to a stub.",
        )


class PublicDocsNoDeploymentLeaksTest(unittest.TestCase):
    """Public recipes must contain placeholders, not a real deployment map."""

    def _scan(self, path: Path) -> list[str]:
        text = path.read_text(encoding="utf-8")
        failures: list[str] = []
        for match in CONCRETE_HOME_RE.finditer(text):
            failures.append(f"concrete home path `{match.group(0)}`")
        for match in CONFIGURED_TELEGRAM_ID_RE.finditer(text):
            failures.append(f"concrete Telegram config `{match.group(0)}`")
        for raw_ip in IPV4_RE.findall(text):
            try:
                address = ipaddress.ip_address(raw_ip)
            except ValueError:
                continue
            if address in ipaddress.ip_network("100.64.0.0/10"):
                failures.append(f"tailnet address `{raw_ip}`")
        return failures

    def test_all_public_docs_no_structural_leaks(self) -> None:
        failures: list[str] = []
        for path in PUBLIC_DOCS:
            for leak in self._scan(path):
                failures.append(f"{path.name}: {leak}")
        self.assertEqual(failures, [], "\n".join(failures))


class PublicDocsPathsGeneralizedTest(unittest.TestCase):
    """Deployment paths must be expressed as copy-editable placeholders."""

    def test_canary_smoke_uses_placeholder_path(self) -> None:
        text = CANARY_SMOKE.read_text(encoding="utf-8")
        self.assertIn(
            "~/path/to/your/.claude-lab",
            text,
            "Sanitized runbook should reference the placeholder "
            "`~/path/to/your/.claude-lab` so third-party operators see how to "
            "adapt the commands.",
        )


class PublicDocsPlaceholderHintsTest(unittest.TestCase):
    """The runbook must explain its placeholders so a stranger can follow it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = CANARY_SMOKE.read_text(encoding="utf-8")

    def test_test_bot_placeholder_present(self) -> None:
        self.assertIn(
            "<test-bot-id>",
            self.text,
            "Runbook should use `<test-bot-id>` placeholder where the leaked "
            "concrete id used to live.",
        )

    def test_user_id_placeholder_present(self) -> None:
        self.assertIn(
            "<your-telegram-user-id>",
            self.text,
            "Runbook should use `<your-telegram-user-id>` placeholder where "
            "the operator's concrete id used to live.",
        )

    def test_userinfobot_hint_present(self) -> None:
        self.assertIn(
            "userinfobot",
            self.text,
            "Runbook should mention @userinfobot so operators know how to "
            "discover their numeric Telegram user id.",
        )

    def test_pre_cutover_section_marked(self) -> None:
        # Rule #5 of the sanitization spec: gateway.py references stay, but
        # must be marked as a pre-cutover migration path.
        self.assertIn(
            "Pre-cutover",
            self.text,
            "Runbook must mark Python `gateway.py` sections as `Pre-cutover` "
            "so fresh installers know to skip them.",
        )

    def test_operator_approval_wording(self) -> None:
        # "владелец approval" / "operator" was replaced with "operator approval".
        self.assertIn(
            "operator approval",
            self.text,
            "Production cutover sentence should read `operator approval` "
            "instead of deployment-specific role wording.",
        )


class PreCutoverWarningTest(unittest.TestCase):
    """MED-G #2: pre-cutover marker must include the 2026-06-15 cutover date
    and an explicit instruction for fresh installers, not a generic skip note."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = CANARY_SMOKE.read_text(encoding="utf-8")

    def test_warning_glyph_present(self) -> None:
        self.assertIn(
            "⚠ Pre-cutover (Python gateway.py)",
            self.text,
            "Pre-cutover header must lead with the ⚠ warning glyph and the "
            "exact phrase `Pre-cutover (Python gateway.py)` so the section is "
            "visually distinct from the rest of the runbook.",
        )

    def test_cutover_date_present(self) -> None:
        self.assertIn(
            "2026-06-15 cutover",
            self.text,
            "Pre-cutover marker must reference the `2026-06-15 cutover` date "
            "so readers know when the Python gateway path stops being supported.",
        )

    def test_legacy_reference_clause(self) -> None:
        self.assertIn(
            "becomes legacy reference only",
            self.text,
            "Pre-cutover marker must explicitly say the section "
            "`becomes legacy reference only` after the cutover.",
        )

    def test_skip_if_installing_fresh(self) -> None:
        self.assertIn(
            "Skip if installing fresh",
            self.text,
            "Pre-cutover marker must instruct fresh installers to "
            "`Skip if installing fresh`.",
        )


class SmokeMatrixCoverageTest(unittest.TestCase):
    """MED-G #11: smoke matrix must cover the multichat-era features that
    landed in PR #13 (TaskMirror), PR #22 (format=html default), and
    PR #26 (MultichatRouter + TmuxSessionPool + TmuxMirror)."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = CANARY_SMOKE.read_text(encoding="utf-8")

    def test_matrix_mentions_multichat_router(self) -> None:
        self.assertIn(
            "MultichatRouter",
            self.text,
            "Smoke matrix must include MultichatRouter rows (default-OFF + "
            "enabled-in-allowed-group) so operators verify PR #26 gating.",
        )

    def test_matrix_mentions_tmux_session_pool(self) -> None:
        self.assertIn(
            "TmuxSessionPool",
            self.text,
            "Smoke matrix must include TmuxSessionPool reuse + idle-kill rows "
            "so operators verify per-chat session lifecycle from PR #26.",
        )

    def test_matrix_mentions_tmux_mirror(self) -> None:
        self.assertIn(
            "TmuxMirror",
            self.text,
            "Smoke matrix must include TmuxMirror rows (enabled in DM, "
            "disabled in group) so operators verify the operator-DM-only "
            "policy for the live progress mirror.",
        )

    def test_matrix_mentions_task_mirror(self) -> None:
        self.assertIn(
            "TaskMirror",
            self.text,
            "Smoke matrix must include a TaskMirror row covering PR #13 "
            "todo-task in-place updates.",
        )

    def test_matrix_mentions_redaction(self) -> None:
        self.assertIn(
            "redact",
            self.text.lower(),
            "Smoke matrix must include a safe-telegram-api redaction row so "
            "operators verify telegram token leak protection.",
        )

    def test_matrix_mentions_format_html(self) -> None:
        self.assertIn(
            "format=html",
            self.text,
            "Smoke matrix must include a `format=html` default row covering "
            "PR #22 HTML-by-default reply rendering.",
        )

    def test_matrix_mentions_format_text_override(self) -> None:
        self.assertIn(
            "format=text",
            self.text,
            "Smoke matrix must include a `format=text` override row so "
            "operators can confirm the opt-out path from HTML rendering.",
        )

    def test_multichat_section_header_present(self) -> None:
        """Operators need a clear anchor so they can decide to skip the
        multichat block when the features are disabled in their build."""
        self.assertIn(
            "### Multichat-era smoke",
            self.text,
            "Multichat rows must be grouped under a `### Multichat-era smoke` "
            "subheader so operators can skip them when MULTICHAT_ENABLED=false.",
        )


if __name__ == "__main__":
    unittest.main()
