<p align="center">
  <img src="docs/assets/codex-tg-wire-hero.svg" width="100%" alt="codex-tg-wire connects Telegram to Codex App Server through a durable SQLite wire">
</p>

<p align="center">
  <strong>Run persistent Codex threads from Telegram — and safely pick them up in your terminal.</strong>
</p>

<p align="center">
  <a href="README.ru.md">Русский</a> · English
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache 2.0" src="https://img.shields.io/badge/license-Apache--2.0-2563eb"></a>
  <a href="plugin/docs/codex-compatibility.md"><img alt="Codex CLI 0.149.1" src="https://img.shields.io/badge/Codex_CLI-0.149.1-7c3aed"></a>
  <a href="plugin/package.json"><img alt="Bun 1.4" src="https://img.shields.io/badge/runtime-Bun_1.4-f59e0b"></a>
  <a href="#release-status"><img alt="Hardened pre-release" src="https://img.shields.io/badge/status-hardened_pre--release-0f766e"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#how-to-use-it">How to use it</a> ·
  <a href="#five-real-workflows">Use cases</a> ·
  <a href="#what-you-can-do">Features</a> ·
  <a href="#how-it-works">Architecture</a> ·
  <a href="#codex-tg-wire-vs-dashi">Dashi comparison</a> ·
  <a href="#documentation">Docs</a>
</p>

---

Send Codex a task while you are away from your desk, follow its progress, answer
approval requests, inspect the diff, and continue the same thread locally later.
codex-tg-wire is an owner-only, self-hosted bridge built for actual coding work —
not a stateless chat wrapper.

| Keep the context | Stay in control | Survive the ugly failures |
|---|---|---|
| Continue native Codex threads from Telegram or hand them back to `codex resume`. | Stop, steer, queue, review, approve, change model and sandbox from inline controls. | SQLite inbox/outbox, restart recovery and explicit `UNKNOWN`/`AMBIGUOUS` states prevent silent loss and unsafe retries. |

## Quick start

You need **Linux with systemd --user** and a **Telegram bot token** from
`@BotFather`. The installer adds its pinned Bun runtime under `~/.bun` when
needed, brings the compatible Codex CLI, and automatically reuses your local
`~/.codex` account when one exists. No `sudo` is used.

```bash
git clone https://github.com/aipolukhin/codex-tg-wire.git
cd codex-tg-wire
./install.sh
```

The console asks only for the token, installs the user service and prints a
short **Activate bot** link. Press **START** there: Telegram is bound as the
sole owner, then the bot lets you create/use `~/codex-workspace` or enter another
absolute project path and asks for **YOLO** or **Safe**. The compact 96-bit link
secret prevents an unrelated `/start` from claiming ownership.

The service then restarts directly into the full bridge. Continue with the
button in Telegram: **Connect Codex** opens device login only when local auth is
missing, **Check login** verifies it, **Create Groq key** optionally enables
voice transcription, and **Start the first task** finishes onboarding. After
the token is entered, normal setup needs no more terminal input. No `sudo`,
dedicated Unix account or Docker is required for this default path.

```text
/start
```

Prefer containers? Docker is optional, not the default:

```bash
./docker.sh setup
```

It keeps config, SQLite and `CODEX_HOME` on the host, but uses a hardened
non-root container. The installer mounts `~/codex-workspace` by default (or the
absolute path passed with `--project`); confirm that project and choose the mode
in the bot. Codex login still happens there, while `./docker.sh login` is only a
recovery fallback.

> [!CAUTION]
> The recommended **YOLO** profile uses `approvalPolicy=never` and
> `sandbox=danger-full-access`. It is convenient, but anyone controlling the
> allowed Telegram account can act with your Linux user rights. A stolen bot
> token exposes bridge traffic and must also be treated as an incident. Choose
> **Safe** during onboarding or run `./install.sh --profile safe` for
> `on-request` + `workspace-write`.

[Installation details](plugin/docs/codex-installation.md) ·
[Docker and production deployment](plugin/docs/codex-installation.md#docker-compose-installation)

## What you can do

### Use Codex like a remote workspace

| I want to… | From Telegram |
|---|---|
| Start or continue work | Send a message, `/new`, `/sessions`, `/attach <thread-id>` |
| Return to my terminal | `/handback` prints a safely quoted `codex resume` command |
| Control a running turn | `/stop`, `/steer <text>`, or choose steer/queue/replace/cancel when busy |
| Change execution settings | `/settings` for model, effort, sandbox, approvals, project and Guided Plan |
| Inspect the result | `/diff [path]`, `/file [--all] <path>`, `/review` |
| Check the account | `/auth`, `/login`, `/limits`, `/usage`, `/version` |
| Manage native sessions | `/rename`, `/archive`, `/unarchive`, `/fork`, `/compact` |

After owner activation, the bot registers this command menu only for the owner's
private chat, so typing `/` opens native Telegram suggestions.

The chat stays quiet and native: Telegram shows **typing…** while Codex works,
the accepted owner message gets a 👀 receipt, and one silent pinned status is
edited in place as one preview-friendly line, for example
`gpt-5.6-sol xhigh 5h:80% w:90% ctx:20%`. Quotas are remaining;
`ctx` is occupied model context. Task steps and current activity never go into
that pin. During a multi-step turn Codex updates a separate Rich Message named
**Task progress** after every verified step; that one card is edited in place.
User-facing commentary is projected into the same card, together with the
current activity and its elapsed time. A long operation can therefore say, for
example, `rsync is moving 80 GB · running for 18 min`, while a one-minute
heartbeat keeps proving that the turn is alive.

Replying to a delivered Codex answer routes the next message back to the exact
thread that produced it — even if you switched sessions in the meantime.

### Discuss first without accidentally starting implementation

Concept-oriented messages such as “let's discuss”, “what do you propose?” or
“how should we build this?” open a durable discussion in read-only mode. Once
opened, further requirements stay read-only instead of being reclassified as a
new task. The latest recommendation is the execution scope; press
**Implement** or send an unambiguous contextual go-ahead to execute it.

A standalone direct task such as “fix the image delivery” still executes
immediately. Enable `/plan on` when every new task should require confirmation.
Both flows use the same durable gate:

```text
discussion in read-only mode → refine or close → confirm scope → execute normally
```

Planning and revision are forced to `sandbox=read-only` with
`approvalPolicy=never`. The workspace only becomes writable after you press
**Implement**. The pending discussion and selected action survive a bridge restart.

### Work with real project artifacts

- images and audio reach Codex as native App Server inputs;
- allowlisted documents are verified, stored privately and exposed by safe path;
- media groups become one atomic Codex turn;
- `/file --all` sends a project file through the same durable outbox;
- optional Groq transcription can enrich voice input without replacing the
  original audio available to Codex.

## How to use it

1. Send `/start` once and follow the action buttons. Existing host Codex auth is
   detected automatically; otherwise tap **Connect Codex** and complete the
   browser login. Groq voice is optional and can be skipped.
2. Send a task as an ordinary Telegram message. The bridge creates or resumes a
   native Codex thread and returns the final answer as an ordinary chat message.
   Technical lifecycle details stay available on demand through `/status`.
3. When Codex needs a decision, answer from the inline controls. If another
   message arrives during a turn, choose **Steer now**, **Queue next**, **Stop &
   replace**, or **Cancel message**.
4. Use `/settings` for model, effort, sandbox, approvals, project and Guided
   Plan. Use `/diff`, `/review` and `/file` to inspect or receive the result.
5. Use `/sessions` to attach another native thread. `/handback` gives a quoted
   `codex resume` command when you want the same context back in your terminal.

Commands remain available for power users, but onboarding and common decisions
are designed around concrete Telegram actions rather than memorizing syntax.

## Five real workflows

### 1. Build a feature without granting write access too early

Open `/settings`, tap **Guided Plan · On**, then send: “Add passwordless login,
cover it with tests and update the docs.” Codex drafts in read-only mode. Tap
**Revise plan**, **Execute plan**, or **Cancel**; after execution, inspect
`/diff`, run `/review`, and request the changed file with `/file`.

### 2. Correct a live hotfix from your phone

Send an error screenshot and ask Codex to diagnose production behavior. While
the turn runs, send a correction and tap **Steer now** so it reaches that exact
turn. A second independent request can be **Queued next**; `/stop` remains the
emergency brake. Replies to old Codex messages route to the thread that produced
them, not whichever thread happens to be selected now.

### 3. Turn field evidence into a coding task

Forward photos, an allowlisted log/document, or a Telegram media group and add a
caption. They become one durable turn with verified local files. Send a voice
note for the follow-up: Codex always receives the original audio, while optional
Groq adds a transcript after you connect it from the onboarding card.

### 4. Recover after a server or network failure

Restart the service or container during a long turn. The bridge reconciles the
saved Codex turn instead of silently launching a duplicate. `/status` shows the
recovered thread; `/failed` and `/ambiguous` expose delivery problems and let
you retry, resolve or archive only where the evidence makes that safe.

### 5. Move the same session between Telegram and your desk

Start a refactor on Telegram, inspect usage with `/usage`, then use `/handback`
and resume the exact native thread locally. Later `/sessions` discovers it,
`/attach` brings it back to the bot, and `/fork`, `/compact`, `/rename` or
`/archive` manage its lifecycle without copying the conversation into a second
session store.

## How it works

```text
Telegram update
      │
      ▼
SQLite/WAL inbox ──► session coordinator ──► codex app-server --stdio
      │                                              │
      └──── problem center ◄── SQLite/WAL outbox ◄───┘
```

There is no tmux, terminal mirror or transcript classifier in the Codex runtime.
The bridge service supervises a local App Server child process over stdio.

| State | Source of truth |
|---|---|
| Complete resumable Codex thread | Codex's local `CODEX_HOME` store |
| Accepted Telegram updates and polling cursor | Bridge SQLite/WAL inbox |
| Queues, settings, approvals and recovery state | Bridge SQLite/WAL control tables |
| Telegram sends, edits and media delivery proof | Bridge SQLite/WAL outbox |
| User-facing conversation | Telegram messages; not treated as a full Codex transcript |

<details>
<summary><strong>What happens when something crashes?</strong></summary>

| Boundary | Behavior |
|---|---|
| Duplicate Telegram update | `(bot_id, update_id)` deduplicates it. |
| Process dies before a Telegram send starts | The leased job returns to bounded retry. |
| Send may have reached Telegram, but the response was lost | The job becomes `AMBIGUOUS`; it is never retried automatically. |
| App Server disappears during a turn | The saved turn is reconciled through `thread/read`; uncertain work becomes visible `UNKNOWN`, not a replacement turn. |
| Owner needs to recover delivery | `/failed` and `/ambiguous` expose safe metadata with idempotent retry/resolve/archive actions. |

codex-tg-wire deliberately does not claim impossible end-to-end exactly-once
delivery. It preserves evidence, makes uncertainty visible, and refuses the
dangerous retry when duplication cannot be ruled out.

</details>

## codex-tg-wire vs Dashi

codex-tg-wire started from Dashi's TypeScript/Bun and Telegram UX baseline, but
it is now a different product with a different runtime and reliability model.

| | codex-tg-wire | Dashi |
|---|---|---|
| Agent runtime | Native Codex App Server threads and turns | Claude Code session through channel/tmux lifecycle |
| Session storage | Codex `CODEX_HOME`; attach, fork, compact and local handback | Claude transcript and live terminal/tmux state |
| Delivery state | Transactional SQLite/WAL inbox/outbox with leases and ambiguity handling | File-oriented bridge queues and transcript-based fallbacks |
| Telegram focus | Private allowlisted owner workflow | Richer multichat, groups/topics and personas |
| Native controls | Codex account, usage, limits, sessions, diff and inline review | Claude hooks, terminal mirror, `/keys`, `/cc` |
| Best fit | One owner who wants a durable Codex workstation in Telegram | Claude-centric teams needing Dashi's broader chat surface |

We intentionally did **not** carry over tmux transport, Claude hooks, Guest Mode,
public chats, fleet orchestration or full Dashi multichat. See the
[provenance and exclusions map](docs/provenance.md) for the reasoning.

## Security at a glance

- user and chat allowlists are mandatory and deny by default;
- tokens stay outside JSON and SQLite;
- paths are confined to configured projects and verified again before use;
- outgoing text is redacted and Telegram HTML is validated;
- answers, files and user-requested edits/deletes use the durable outbox;
- cosmetic typing, 👀 receipt and the replaceable pinned status are best-effort
  native Telegram presence and can never block or retry a Codex turn;
- old completed payloads, diffs and reply routes are scrubbed by retention;
- Safe and YOLO are explicit execution profiles, not hidden behavior.

Read the complete [security contract](plugin/docs/codex-security.md) before
exposing a powerful coding agent through Telegram.

## Documentation

| Guide | Use it when… |
|---|---|
| [Installation](plugin/docs/codex-installation.md) | installing with user-systemd, system-wide systemd or Docker Compose |
| [Production runbook](plugin/docs/codex-production.md) | operating readiness, backup, restore, retention and a live soak |
| [Upgrade and rollback](plugin/docs/codex-upgrade.md) | moving between verified artifacts without risking the database |
| [Security contract](plugin/docs/codex-security.md) | reviewing trust boundaries, secrets and incident handling |
| [Compatibility](plugin/docs/codex-compatibility.md) | checking the exact Codex CLI, Bun and App Server schema support |
| [Roadmap](ROADMAP.md) | seeing completed milestones and post-v1 direction |
| [Provenance](docs/provenance.md) | understanding what came from Dashi, Telemax and other references |

## Release status

The v1 implementation and artifact install → restart → resume acceptance gate are
complete. The project remains a **hardened pre-release** until a clean operator
install and a real 72-hour Telegram/Codex canary complete. The supported surface
is currently private allowlisted chats with a local stdio App Server. Groups,
topics, fleet orchestration and remote App Server transport are post-v1 work.

<details>
<summary><strong>Development and verification</strong></summary>

```bash
cd plugin
bun install --frozen-lockfile
bun run typecheck
bun test
bun run codex:schema:check
```

Useful operator checks:

```bash
bun run doctor:codex --online
bun run backup:codex -- /safe/path/bridge.sqlite3
bun run acceptance:codex
bun run release:codex
```

The production entry point is `bun run start:codex`. Some inherited Claude
modules remain in the source tree while shared Telegram primitives are being
extracted; the Codex entry point does not load them.

</details>

## Origins and license

The Telegram UX baseline comes from
[Dashi](https://github.com/qwwiwi/dashi-plugin-claude-code). Durable delivery
semantics were informed by [Telemax](https://github.com/aipolukhin/telemax) and
reimplemented in TypeScript; its Python code was not copied. The repository
keeps upstream history and Apache-2.0 attribution — see [NOTICE](NOTICE) and the
[provenance map](docs/provenance.md).

codex-tg-wire is an independent, unofficial project and is not affiliated with
OpenAI or Telegram.
