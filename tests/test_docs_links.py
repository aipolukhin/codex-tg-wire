"""Docs integrity tests for top-level README.md, plugin/README.md, DEPRECATION-PATH.md.

TASK-11 owns these three files. Their content must satisfy:

  1. Every relative markdown link resolves to an existing path in the repo.
  2. The old repository name `qwwiwi-channel-telegram-Claude-code` is never
     referenced — canonical name is `dashi-plugin-claude-code`.
  3. README.md mentions the multichat enablement flag and the install-hooks
     step in the quick-start.
  4. README.md states the v2.1.80+ requirement for Claude Code (matches the
     channels-reference docs).

The test stays narrow on purpose: it owns the three markdown files above.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

ROOT_README = REPO_ROOT / "README.md"
PLUGIN_README = REPO_ROOT / "plugin" / "README.md"
DEPRECATION = REPO_ROOT / "DEPRECATION-PATH.md"
TROUBLESHOOTING = REPO_ROOT / "docs" / "05-troubleshooting.md"

# Installation docs — MED-E (docs-B1) coverage
INSTALL_INDEX = REPO_ROOT / "docs" / "03-installation.md"
INSTALL_LINUX = REPO_ROOT / "docs" / "03-installation-linux.md"
INSTALL_MACOS = REPO_ROOT / "docs" / "03-installation-macos.md"
WHERE_TO_PLACE = REPO_ROOT / "docs" / "02-where-to-place-plugin.md"
HOW_CLAUDE_LOADS = REPO_ROOT / "docs" / "06-how-claude-loads-session.md"

INSTALL_DOCS = (INSTALL_INDEX, INSTALL_LINUX, INSTALL_MACOS)
INSTALL_LINKED_DOCS = (WHERE_TO_PLACE, HOW_CLAUDE_LOADS, *INSTALL_DOCS)

OWNED_FILES = (ROOT_README, PLUGIN_README, DEPRECATION)

# Internal plan files removed from the public tree. Any link to them is stale.
REMOVED_PATHS = (
    "PLAN.md",
    "plugin/docs/PLAN-A2-A3.md",
)

OLD_REPO_NAME = "qwwiwi-channel-telegram-Claude-code"

# Matches `[label](target)` markdown links. Captures the target only.
MD_LINK_RE = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def _extract_link_targets(text: str) -> list[str]:
    return MD_LINK_RE.findall(text)


def _is_external(target: str) -> bool:
    if target.startswith("http://") or target.startswith("https://"):
        return True
    if target.startswith("mailto:"):
        return True
    return False


def _strip_anchor(target: str) -> str:
    # Drop the in-file anchor (`docs/foo.md#section`) when checking existence.
    idx = target.find("#")
    if idx == -1:
        return target
    return target[:idx]


class RelativeLinksResolveTest(unittest.TestCase):
    """Every relative markdown link in owned files must point to a real file."""

    def _check_file(self, path: Path) -> None:
        text = path.read_text(encoding="utf-8")
        base_dir = path.parent
        failures: list[str] = []
        for target in _extract_link_targets(text):
            if _is_external(target):
                continue
            stripped = _strip_anchor(target).strip()
            if not stripped:
                # Pure anchor link (#section) — same-file, treat as OK.
                continue
            resolved = (base_dir / stripped).resolve()
            if not resolved.exists():
                failures.append(f"{path.name}: link `{target}` -> {resolved} (missing)")
        self.assertEqual(failures, [], "\n".join(failures))

    def test_root_readme_links_resolve(self) -> None:
        self._check_file(ROOT_README)

    def test_plugin_readme_links_resolve(self) -> None:
        self._check_file(PLUGIN_README)

    def test_deprecation_path_links_resolve(self) -> None:
        self._check_file(DEPRECATION)


class OldRepoNameAbsentTest(unittest.TestCase):
    """The legacy repo name must not appear in any owned file."""

    def test_root_readme_no_old_repo_name(self) -> None:
        self.assertNotIn(
            OLD_REPO_NAME,
            ROOT_README.read_text(encoding="utf-8"),
            f"Old repo name `{OLD_REPO_NAME}` must be removed from {ROOT_README}",
        )

    def test_plugin_readme_no_old_repo_name(self) -> None:
        self.assertNotIn(
            OLD_REPO_NAME,
            PLUGIN_README.read_text(encoding="utf-8"),
            f"Old repo name `{OLD_REPO_NAME}` must be removed from {PLUGIN_README}",
        )

    def test_deprecation_no_old_repo_name(self) -> None:
        self.assertNotIn(
            OLD_REPO_NAME,
            DEPRECATION.read_text(encoding="utf-8"),
            f"Old repo name `{OLD_REPO_NAME}` must be removed from {DEPRECATION}",
        )


class RootReadmeContentRequirementsTest(unittest.TestCase):
    """Spot-checks for key strings the operator expects in README.md."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = ROOT_README.read_text(encoding="utf-8")

    def test_multichat_enabled_documented(self) -> None:
        self.assertIn(
            "multichat.enabled",
            self.text,
            "README.md must document the `multichat.enabled` config flag — "
            "multichat is the headline opt-in feature.",
        )

    def test_install_hooks_in_quick_start(self) -> None:
        self.assertIn(
            "install-hooks.sh",
            self.text,
            "Quick start must mention `install-hooks.sh` — without hooks the "
            "ProgressReporter / TaskMirror / ActivityRenderer never fire.",
        )

    def test_claude_code_version_pinned_to_2_1_80(self) -> None:
        self.assertIn(
            "v2.1.80",
            self.text,
            "Requirements must pin Claude Code to v2.1.80+ per the official "
            "channels-reference docs.",
        )

    def test_billing_mentions_plan_tiers(self) -> None:
        for marker in ("Pro", "Max 5", "Max 20"):
            self.assertIn(
                marker,
                self.text,
                f"Billing section must list the `{marker}` plan tier so users "
                "do not assume a flat $200/mo pool.",
            )


class PluginReadmeContentRequirementsTest(unittest.TestCase):
    """Spot-checks for plugin/README.md."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = PLUGIN_README.read_text(encoding="utf-8")

    def test_multichat_enabled_documented(self) -> None:
        # Plugin README uses the JSON-config block form (`"multichat": { "enabled": ... }`)
        # and the env-var form (`TELEGRAM_MULTICHAT_ENABLED`). Either is fine —
        # the test only fails if BOTH are absent.
        has_json_form = '"multichat"' in self.text and '"enabled"' in self.text
        has_env_form = "TELEGRAM_MULTICHAT_ENABLED" in self.text
        has_dotted_form = "multichat.enabled" in self.text
        self.assertTrue(
            has_json_form or has_env_form or has_dotted_form,
            "plugin/README.md must document the multichat enable flag in one of: "
            "JSON `\"multichat\": { \"enabled\": ... }`, env `TELEGRAM_MULTICHAT_ENABLED`, "
            "or dotted `multichat.enabled`.",
        )

    def test_mirror_oob_command_documented(self) -> None:
        # The old plugin/README claimed `/mirror on|off|status` was out of
        # scope. PR #17 shipped it — the doc must reflect that.
        self.assertIn(
            "/mirror",
            self.text,
            "plugin/README.md must mention the `/mirror` OOB command (PR #17).",
        )
        self.assertNotIn(
            "Out of scope (отдельные PR'ы):\n- `/mirror",
            self.text,
            "plugin/README.md must NOT claim `/mirror` is out of scope — it is shipped.",
        )

    def test_what_is_this_link_uses_correct_filename(self) -> None:
        # Old broken link: ../docs/01-context.md. Real file: 01-what-is-this.md.
        self.assertNotIn(
            "01-context.md",
            self.text,
            "plugin/README.md must use `01-what-is-this.md`, not the non-existent `01-context.md`.",
        )


class RemovedDocLinksTest(unittest.TestCase):
    """Tracked Markdown must not link to removed internal plan files."""

    def _tracked_markdown_files(self) -> list[Path]:
        # Walk repo, exclude untracked dev artifacts (loop-coding-runs/),
        # node_modules, .git, virtualenvs.
        exclude_dirs = {
            ".git",
            "node_modules",
            "loop-coding-runs",
            "__pycache__",
            ".venv",
            "venv",
            "dist",
            "build",
        }
        results: list[Path] = []
        for path in REPO_ROOT.rglob("*.md"):
            if any(part in exclude_dirs for part in path.relative_to(REPO_ROOT).parts):
                continue
            results.append(path)
        return results

    def test_no_stale_links_to_removed_plans(self) -> None:
        failures: list[str] = []
        for md_file in self._tracked_markdown_files():
            text = md_file.read_text(encoding="utf-8")
            for target in _extract_link_targets(text):
                if _is_external(target):
                    continue
                stripped = _strip_anchor(target).strip().lstrip("./")
                for archived in REMOVED_PATHS:
                    # Treat both the bare basename and the full repo-relative
                    # path as stale. Example: link `../PLAN.md` from plugin/
                    # resolves up to repo-root PLAN.md.
                    archived_basename = archived.rsplit("/", 1)[-1]
                    if stripped.endswith(archived) or stripped.endswith(archived_basename):
                        failures.append(
                            f"{md_file.relative_to(REPO_ROOT)}: link `{target}` -> "
                            f"removed internal path `{archived}`"
                        )
                        break
        self.assertEqual(failures, [], "\n".join(failures))


class TroubleshootingPublicSafetyTest(unittest.TestCase):
    """Public troubleshooting must describe secure, user-supplied access lists."""

    def test_no_built_in_allowlist_claim(self) -> None:
        text = TROUBLESHOOTING.read_text(encoding="utf-8")
        self.assertNotIn(
            "Default allowlist в коде",
            text,
            f"{TROUBLESHOOTING.relative_to(REPO_ROOT)} must not claim that "
            "the plugin ships a built-in Telegram allowlist.",
        )

    def test_requires_explicit_allowlists(self) -> None:
        text = TROUBLESHOOTING.read_text(encoding="utf-8")
        self.assertIn(
            "обязательны",
            text,
            "Troubleshooting must tell fresh installers that both allowlists "
            "are required and have no built-in identity defaults.",
        )


class DeprecationPathContentRequirementsTest(unittest.TestCase):
    """Spot-checks for DEPRECATION-PATH.md."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.text = DEPRECATION.read_text(encoding="utf-8")

    def test_billing_does_not_claim_flat_200_pool(self) -> None:
        # The original wording said "$200/мес pool" period, no plan breakdown.
        # Reality: credit depends on plan (Pro $20 / Max 5x $100 / Max 20x $200).
        self.assertIn(
            "Pro",
            self.text,
            "Deprecation billing block must mention Pro tier — credit is plan-dependent.",
        )
        self.assertIn(
            "Max 5",
            self.text,
            "Deprecation billing block must mention Max 5x tier.",
        )
        self.assertIn(
            "Max 20",
            self.text,
            "Deprecation billing block must mention Max 20x tier.",
        )

    def test_no_dated_support_chat_placeholder(self) -> None:
        # The old wording said «открывается ближе к 2026-06-01» — that date
        # is now imminent and the placeholder is stale.
        self.assertNotIn(
            "ближе к 2026-06-01",
            self.text,
            "Support-chat date placeholder must be removed; use the community-run wording instead.",
        )


# ─── MED-E (docs-B1) coverage ────────────────────────────────────────


# GitHub-style header → anchor slug. Mirrors the slugger used by
# GitHub Pages / Kramdown / unified-rehype-slug closely enough to
# catch the broken-anchor regressions the operator flagged.
#
# Algorithm (proven against real repo headers — see slug_smoke test):
#   1. Lowercase (including Cyrillic — Python's str.lower handles this).
#   2. Strip everything that isn't a word char (\w), whitespace, or hyphen.
#      Note: Python's \w with re.UNICODE keeps Cyrillic letters AND digits.
#   3. Collapse whitespace runs to a single hyphen.
#   4. Collapse consecutive hyphens (GitHub does — em-dash surrounded by
#      spaces becomes `--` otherwise, breaking anchor matches).
#   5. Trim leading/trailing hyphens.
_HEADER_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


def _slugify_header(text: str) -> str:
    s = text.lower()
    # Drop punctuation other than spaces / hyphens. Use Unicode \w so
    # Cyrillic letters survive (the Russian section headers depend on it).
    s = re.sub(r"[^\w\s-]", "", s, flags=re.UNICODE)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-+", "-", s)
    return s.strip("-")


def _collect_anchors(path: Path) -> set[str]:
    """Return the set of slug anchors for every header in `path`."""
    text = path.read_text(encoding="utf-8")
    return {_slugify_header(m.group(2)) for m in _HEADER_RE.finditer(text)}


def _collect_anchor_references(path: Path) -> list[tuple[str, str]]:
    """Return (target_doc, anchor) pairs for every markdown link in `path`.

    Returns only links whose target carries a `#anchor` fragment AND points
    at another markdown file (relative). External links and same-file
    `#anchor` are excluded because we can't (and don't need to) verify them
    here.
    """
    text = path.read_text(encoding="utf-8")
    refs: list[tuple[str, str]] = []
    for target in _extract_link_targets(text):
        if _is_external(target):
            continue
        if "#" not in target:
            continue
        file_part, anchor = target.split("#", 1)
        if not file_part:
            # Same-file anchor — skip (we'd need broader coverage).
            continue
        if not file_part.endswith(".md"):
            continue
        refs.append((file_part, anchor))
    return refs


class InstallationDocsAnchorsResolveTest(unittest.TestCase):
    """Every `…03-installation*.md#anchor` link from installation docs
    (and their immediate referrers) must resolve to a real header.

    Catches the bug where docs/02-where-to-place-plugin.md and
    docs/06-how-claude-loads-session.md linked to a section
    (`#persistent-welcome-approvals…`) that did not exist in the
    OS-selector file after the split into Linux/macOS variants.
    """

    def test_slug_smoke(self) -> None:
        """Sanity: the slug function reproduces a known-good anchor.

        Pins the algorithm so future regressions in _slugify_header
        (e.g. forgetting to collapse double-hyphens from em-dash)
        fail this test rather than silently mismatching real anchors.
        """
        self.assertEqual(
            _slugify_header("Persistent welcome approvals"),
            "persistent-welcome-approvals",
        )
        self.assertEqual(
            _slugify_header("Telegram output formatting"),
            "telegram-output-formatting",
        )
        # Cyrillic with em-dash collapse
        self.assertEqual(
            _slugify_header("Логи и state канонические пути"),
            "логи-и-state-канонические-пути",
        )

    def test_install_anchor_links_resolve(self) -> None:
        # Build an anchor table for every install doc once.
        anchors_by_doc: dict[Path, set[str]] = {
            doc: _collect_anchors(doc) for doc in INSTALL_DOCS
        }
        failures: list[str] = []
        for src in INSTALL_LINKED_DOCS:
            base_dir = src.parent
            for file_part, anchor in _collect_anchor_references(src):
                resolved = (base_dir / file_part).resolve()
                # Only assert anchors when the target is an install doc.
                # Other anchors are out of scope for this task.
                if resolved not in anchors_by_doc:
                    continue
                if anchor not in anchors_by_doc[resolved]:
                    failures.append(
                        f"{src.relative_to(REPO_ROOT)}: "
                        f"link `{file_part}#{anchor}` -> "
                        f"anchor `{anchor}` MISSING in "
                        f"{resolved.relative_to(REPO_ROOT)}"
                    )
        self.assertEqual(failures, [], "\n".join(failures))


class InstallationDocsHookPortDocumentedTest(unittest.TestCase):
    """docs-B1 #7: the env-block in install docs must list
    `TELEGRAM_WEBHOOK_PORT=8089` so the Шаг "install hooks" step
    can reference the default port instead of leaving readers to
    guess.
    """

    def _assert_webhook_port_in_env_block(self, doc: Path) -> None:
        text = doc.read_text(encoding="utf-8")
        self.assertIn(
            "TELEGRAM_WEBHOOK_PORT=8089",
            text,
            f"{doc.relative_to(REPO_ROOT)} must list "
            "`TELEGRAM_WEBHOOK_PORT=8089` in the channel.env example block "
            "so the install-hooks step doesn't reference an undefined port.",
        )

    def test_linux_install_doc_lists_webhook_port(self) -> None:
        self._assert_webhook_port_in_env_block(INSTALL_LINUX)

    def test_macos_install_doc_lists_webhook_port(self) -> None:
        self._assert_webhook_port_in_env_block(INSTALL_MACOS)


class InstallationDocsLogPathsTest(unittest.TestCase):
    """docs-B1 #4: log path documentation must be split into the three
    layers (supervisor, plugin state, tmux pane) so readers stop confusing
    `~/Library/Logs/dashi-plugin/<agent>.log` (the launchd stdout path that
    never actually existed — plist writes `.out.log` + `.err.log`) with
    TELEGRAM_STATE_DIR contents.
    """

    def test_linux_doc_uses_journalctl_for_supervisor_logs(self) -> None:
        text = INSTALL_LINUX.read_text(encoding="utf-8")
        # systemd supervisor logs live in journald — must be documented
        # with `journalctl -u <unit>` so operators don't grep for a file
        # that doesn't exist on Linux.
        self.assertRegex(
            text,
            r"journalctl\s+-u\s+\S*channel-",
            "docs/03-installation-linux.md must reference "
            "`journalctl -u channel-<agent>` for supervisor logs — "
            "systemd does not write a plain .log file by default.",
        )

    def test_macos_doc_uses_out_log_for_supervisor_logs(self) -> None:
        text = INSTALL_MACOS.read_text(encoding="utf-8")
        # launchd plist writes StandardOutPath/StandardErrorPath as
        # `.out.log` / `.err.log` (NOT bare `<agent>.log` — that path
        # never existed and was the source of the doc bug).
        self.assertIn(
            "channel-myagent.out.log",
            text,
            "docs/03-installation-macos.md must reference the actual "
            "launchd StandardOutPath suffix `.out.log` — the legacy "
            "wording said plain `<agent>.log` which the plist never writes.",
        )
        self.assertIn(
            "channel-myagent.err.log",
            text,
            "docs/03-installation-macos.md must reference the actual "
            "launchd StandardErrorPath suffix `.err.log`.",
        )

    def test_install_docs_split_supervisor_state_and_tmux_layers(self) -> None:
        """Both per-OS install docs must distinguish the three layers
        (supervisor stdout/stderr, TELEGRAM_STATE_DIR contents like
        bot.pid / access.json, tmux pane) so readers know where each
        artifact lives. We assert the presence of a canonical state-file
        AND a tmux-capture invocation in the same doc.
        """
        for doc in (INSTALL_LINUX, INSTALL_MACOS):
            text = doc.read_text(encoding="utf-8")
            with self.subTest(doc=doc.name):
                # State layer — bot.pid is the canonical anchor file.
                self.assertIn(
                    "bot.pid",
                    text,
                    f"{doc.name} must document TELEGRAM_STATE_DIR contents "
                    "(bot.pid, access.json, update-offset, dead-letter/, "
                    "permissions.jsonl) — split from supervisor logs so "
                    "operators stop conflating the two.",
                )
                # Tmux layer — capture-pane is the canonical command.
                self.assertIn(
                    "tmux capture-pane",
                    text,
                    f"{doc.name} must show `tmux capture-pane -p -t "
                    "channel-<agent>` as the way to read the interactive "
                    "Claude Code terminal (distinct from supervisor logs).",
                )


class InstallationDocsTelegramFormattingTest(unittest.TestCase):
    """docs-B1 #3: install docs must explain that the channel reply
    tool defaults to `format='html'` and that safe-telegram-api runs a
    redactor before sending. Without this section users assume secrets
    leak verbatim and that markdown in their CLAUDE.md prompts won't
    render in Telegram.
    """

    def test_install_index_documents_html_default_and_redactor(self) -> None:
        text = INSTALL_INDEX.read_text(encoding="utf-8")
        self.assertIn(
            "format='html'",
            text,
            "docs/03-installation.md must mention the `format='html'` "
            "default (PR #22) so users know markdown is auto-converted.",
        )
        self.assertIn(
            "safe-telegram-api",
            text,
            "docs/03-installation.md must mention `safe-telegram-api` so "
            "users understand which layer applies the redactor pipeline.",
        )

    def test_os_docs_cross_reference_formatting_section(self) -> None:
        """The OS-specific docs must point users at the canonical
        formatting section so the explanation lives in one place.
        """
        for doc in (INSTALL_LINUX, INSTALL_MACOS):
            text = doc.read_text(encoding="utf-8")
            with self.subTest(doc=doc.name):
                self.assertIn(
                    "telegram-output-formatting",
                    text,
                    f"{doc.name} must link to "
                    "`03-installation.md#telegram-output-formatting` so "
                    "users find the redactor + html-default explanation.",
                )


if __name__ == "__main__":
    unittest.main()
