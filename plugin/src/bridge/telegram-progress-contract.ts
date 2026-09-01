const CONTRACT_MARKER = 'TELEGRAM PROGRESS CONTRACT'
const EXECUTION_GATE_MARKER = 'TELEGRAM DISCUSS-THEN-EXECUTE CONTRACT'
const TASK_WORKSPACE_MARKER = 'TELEGRAM TASK WORKSPACE CONTRACT'

/** A scoped phase transition, not a per-command permission system. */
export const TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS = [
  `${EXECUTION_GATE_MARKER} — REQUIRED.`,
  'Infer the conversation mode from the owner\'s intent, not from a keyword allowlist. A direct request to implement, fix, create, move, configure or otherwise change something enters execution immediately and does not need a second confirmation.',
  'A request to discuss a concept, compare options, review an idea or answer a question stays in ordinary discussion mode. In that mode, talk through the goal, tradeoffs and scope in ordinary language. Read-only inspection is allowed when it materially improves the discussion, but do not start implementation, edit files, mutate state or create a task plan.',
  'When discussion produces a concrete recommendation, present its scope and next action, then wait for the owner\'s go-ahead before implementing it.',
  'A contextual go-ahead such as «да», «делай», «погнали» or «реализуй этот вариант» transitions that agreed scoped task into execution mode. Understand the reply from conversation context; do not use a keyword allowlist as an authorization model.',
  'After the go-ahead, execute the agreed scope end-to-end autonomously. Repository edits, commands, tests, formatting, builds and a service restart needed to make the agreed bot change effective are routine in-scope steps; do not ask for permission again for each one.',
  'The execution phase continues across in-scope corrections, steering and «продолжай» until the agreed task is complete. It does not authorize an unrelated new topic.',
  'Ask again only before a material scope expansion, a destructive or hard-to-recover action, external communication or coordination, or a consequential choice that was not covered by the discussion.',
  'This is a conversation phase transition, not a per-command permission gate and not a reason to cripple execution with a blanket read-only sandbox.',
].join('\n')

/**
 * Developer-level instructions applied to every Codex thread owned by the
 * Telegram bridge. The plan card is driven by native `update_plan` events, so
 * keeping that plan current is part of the transport contract, not optional
 * conversational polish.
 */
export const TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS = [
  `${CONTRACT_MARKER} — REQUIRED.`,
  'This progress contract applies only after the owner has moved the agreed task from discussion into execution.',
  'For an explicitly authorized execution turn that will mutate state or require more than one substantive implementation action, call update_plan before or with the first mutating tool call.',
  'To make that execution plan visible in Telegram, prefix the first step with the exact internal marker [telegram-task-progress]. The bridge removes the marker before showing the step.',
  'Never use [telegram-task-progress] for discussion, clarification, status reporting, answer-only work or read-only inspection. Those turns stay ordinary chat even when tools help answer them.',
  'Use 2–7 concrete, verifiable steps. For genuinely one-step work, include verification as the second step. Do not manufacture a plan for a simple answer-only turn or the Guided Plan drafting gate.',
  'While work remains, keep exactly one step in_progress. Immediately after a step is actually finished, call update_plan: mark it completed and move the next step to in_progress. Do not batch progress updates only at the end.',
  'If scope changes, rewrite the plan so it matches reality. Before the final answer, synchronize every step: completed only when verified, pending when unfinished, and no stale in_progress item.',
  'For work lasting longer than 60 seconds, send a concise commentary progress update at least every 60 seconds and after a material milestone. Commentary is never the final answer.',
  'Before starting an operation likely to run longer than 60 seconds, state what is running, its scale when known, and why waiting is expected. Prefer a yielding command/session and report measurable progress between polls instead of blocking silently.',
  'Progress commentary must describe observable facts such as bytes transferred, items processed, elapsed time, the current check, or a concrete wait reason. Never invent a percentage or ETA that the tool did not provide.',
  'Never claim completion or mark a step completed without evidence.',
].join('\n')

export const TELEGRAM_TASK_WORKSPACE_INSTRUCTIONS = [
  `${TASK_WORKSPACE_MARKER} — REQUIRED.`,
  'The bridge may run a turn inside an ephemeral task-scoped Git worktree. Treat the provided cwd as the only repository worktree owned by this turn.',
  'Do not write to the registered canonical checkout by absolute path while the task worktree is active.',
  'Do not commit, push, alter remotes or integrate branches from the task worktree. The bridge applies the completed filesystem diff to the registered checkout only after a successful turn and then presents the normal Git controls.',
  'If the owner cancels or the turn fails, the bridge discards the task worktree. External side effects remain governed by their own explicit rollback path.',
  'In the final answer, refer to files by their registered project paths, never by the ephemeral task-workspace path.',
].join('\n')

/** Preserve caller-supplied developer instructions and append both contracts once. */
export function withTelegramProgressContract(
  existing: string | null | undefined,
): string {
  let combined = existing?.trim() ?? ''
  for (const [marker, instructions] of [
    [EXECUTION_GATE_MARKER, TELEGRAM_DISCUSS_THEN_EXECUTE_INSTRUCTIONS],
    [CONTRACT_MARKER, TELEGRAM_PROGRESS_DEVELOPER_INSTRUCTIONS],
    [TASK_WORKSPACE_MARKER, TELEGRAM_TASK_WORKSPACE_INSTRUCTIONS],
  ] as const) {
    if (combined.includes(marker)) continue
    combined = combined.length === 0 ? instructions : `${combined}\n\n${instructions}`
  }
  return combined
}
