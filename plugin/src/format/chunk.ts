// Telegram message chunking.
//
// Telegram caps sendMessage at 4096 chars. We chunk at 4000 by default to
// leave headroom for grammY's reply_parameters / parse_mode overhead.
//
// Boundary preference (port of gateway.py:514-562 + pre/code preservation
// improvement requested in PLAN T5):
//   1. Paragraph (\n\n) — split at the last paragraph break that fits
//   2. Line (\n) — split at the last line break that fits
//   3. Hard cut at `max` chars — only when neither boundary exists
//
// HTML preservation: if a split lands inside a supported Telegram HTML
// span, we close every open tag on the emitted chunk and reopen the exact
// opening tags (including safe attributes such as href) on the next one.

export const TELEGRAM_MAX_MESSAGE = 4096
const DEFAULT_MAX = 4000

const BALANCED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'code',
  'del',
  'em',
  'i',
  'ins',
  'pre',
  's',
  'strike',
  'strong',
  'tg-spoiler',
  'u',
])

interface OpenTag {
  name: string
  raw: string
}

interface OpenTagState {
  // Tags currently open at the cut point. Outermost first, innermost last —
  // we close innermost→outermost and reopen outermost→innermost.
  open: OpenTag[]
}

/**
 * Scan `text` and report which supported tags are still open at the end of
 * the substring. Exact opening text is retained so `<a href="…">` and
 * `<blockquote expandable>` remain valid when reopened in the next chunk.
 */
function openTagsAt(text: string): OpenTagState {
  const stack: OpenTag[] = []
  const re = /<\s*(\/?)\s*([a-z][a-z0-9-]*)\b[^>]*>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const isClose = m[1] === '/'
    const tag = (m[2] as string).toLowerCase()
    if (!BALANCED_TAGS.has(tag)) continue
    if (isClose) {
      // Pop the most recent matching open. If none, ignore — input was
      // already malformed and we can't fix it here.
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]?.name === tag) {
          stack.splice(i, 1)
          break
        }
      }
    } else if (!m[0].trimEnd().endsWith('/>')) {
      stack.push({ name: tag, raw: m[0] })
    }
  }
  return { open: stack }
}

function closingTagsFor(state: OpenTagState): string {
  // Close innermost first.
  return [...state.open].reverse().map((tag) => `</${tag.name}>`).join('')
}

function openingTagsFor(state: OpenTagState): string {
  return state.open.map((tag) => tag.raw).join('')
}

/**
 * Choose the best cut index within [0, max] for `text`. Returns the cut
 * position (exclusive).
 *
 * Strict preference order (PLAN.md T5):
 *   1. last paragraph break (`\n\n`) at any position in [0, max]
 *   2. last line break (`\n`) at any position in [0, max]
 *   3. hard cut at exactly `max`
 *
 * No `minCut` floor: if the only natural boundary sits low (e.g. a 30-char
 * header followed by 4000 chars of single-line body), we still prefer it
 * over a hard cut in the middle of the line. Tiny prefix chunks are an
 * acceptable cost for honouring the documented preference order.
 */
function chooseCut(text: string, max: number): number {
  if (text.length <= max) return text.length

  const slice = text.slice(0, max)
  const lastPara = slice.lastIndexOf('\n\n')
  if (lastPara >= 0) {
    const cut = lastPara + 2 // include the \n\n in the emitted chunk
    // Heading-affinity: never end a chunk on a lone heading line — that
    // orphans the heading at the bottom of one message while its body opens
    // the next. If the chunk we'd emit ends with a `<b>…</b>`-only line,
    // back up to the paragraph boundary BEFORE that heading so the heading
    // travels with its body. Only applied when an earlier boundary exists.
    const backed = avoidOrphanHeading(text, cut)
    return backed ?? cut
  }

  const lastLine = slice.lastIndexOf('\n')
  if (lastLine >= 0) return lastLine + 1

  return max
}

// A rendered heading is a whole line that is EXACTLY one bold span —
// markdownToTelegramHtml emits `# heading` and `**bold**` alike as
// `<b>…</b>`. `[^<]+` keeps the match to a single span: a line with several
// bold words («<b>a</b> and <b>b</b>») is prose, not a heading (review fix —
// the previous `[\s\S]*` greedily matched multi-span lines).
const LONE_HEADING_RE = /^<b>[^<]+<\/b>$/

/**
 * If the chunk `text.slice(0, cut)` would end on a lone heading line, return
 * an earlier paragraph-boundary cut (before that heading) so the heading is
 * not orphaned. Returns undefined when the chunk does not end on a heading,
 * when there is no earlier boundary to back up to, or when backing up would
 * emit a WHITESPACE-ONLY chunk (Telegram 400s an empty message and the whole
 * reply would fail — an orphaned heading is the lesser evil).
 */
function avoidOrphanHeading(text: string, cut: number): number | undefined {
  const body = text.slice(0, cut)
  const trimmed = body.replace(/\n+$/, '')
  const lastLineStart = trimmed.lastIndexOf('\n') + 1
  const lastLine = trimmed.slice(lastLineStart).trim()
  if (!LONE_HEADING_RE.test(lastLine)) return undefined

  const prevPara = trimmed.lastIndexOf('\n\n', lastLineStart - 1)
  if (prevPara < 0) return undefined // no earlier boundary — keep original cut
  // Review fix (2026-07-09): text like "\n\n<b>H</b>\n\n…" would back up to a
  // cut whose chunk is only whitespace — never emit that.
  if (body.slice(0, prevPara + 2).trim() === '') return undefined
  return prevPara + 2
}

/**
 * Split `text` into chunks that each render under Telegram's parse_mode=HTML.
 * Each chunk is <= `max` (default 4000). Leading newlines are trimmed from
 * each chunk after the first.
 *
 * If a supported Telegram HTML tag is open at a cut point, we close it on
 * the emitted chunk and reopen it on the next. Every chunk is independently
 * parseable, including long links, bold spans, quotes and code blocks.
 */
export function splitMessage(text: string, max: number = DEFAULT_MAX): string[] {
  if (max <= 0) throw new Error(`splitMessage: max must be positive, got ${max}`)
  if (text.length === 0) return []
  if (text.length <= max) return [text]

  const chunks: string[] = []
  let remaining = text
  // Tags inherited from the previous chunk that we need to reopen at the
  // start of this chunk.
  let inherited: OpenTagState = { open: [] }

  // Guard against pathological inputs that would otherwise loop forever.
  const hardCap = Math.ceil(text.length / Math.max(1, Math.floor(max / 4))) + 16
  let iterations = 0

  const perTagSuffix = [...BALANCED_TAGS].reduce(
    (max, tag) => Math.max(max, (`</${tag}>`).length),
    0,
  )

  while (remaining.length > 0) {
    if (iterations++ > hardCap) {
      // Bail out — emit the rest as a single oversized chunk rather than
      // hang. Tests/typecheck should never hit this; it's defense-in-depth.
      chunks.push(openingTagsFor(inherited) + remaining)
      break
    }

    const prefix = openingTagsFor(inherited)
    // Budget for the substring we cut from `remaining`. Prefix tags eat
    // into the budget; we reserve room only for closing-tags we know are
    // open RIGHT NOW (inherited stack). Tags opened inside `body` are
    // handled by the overflow-recovery branch below.
    const suffixReserve = inherited.open.length * perTagSuffix
    const cut = chooseCut(remaining, Math.max(1, max - prefix.length - suffixReserve))
    const body = remaining.slice(0, cut)

    const afterState = openTagsAt(prefix + body)
    const suffix = closingTagsFor(afterState)
    let chunk = prefix + body + suffix

    // Overflow recovery. The body may open tags that were not part of the
    // inherited suffix reserve. Shrink iteratively: removing text can also
    // remove a closing tag and temporarily grow the required suffix, so a
    // single arithmetic adjustment is not sufficient for nested markup.
    if (chunk.length > max) {
      let adjustedCut = cut
      let adjustedState = afterState
      for (let attempt = 0; attempt < BALANCED_TAGS.size + 4 && chunk.length > max; attempt += 1) {
        adjustedCut = Math.max(1, adjustedCut - Math.max(1, chunk.length - max))
        const candidateBody = remaining.slice(0, adjustedCut)
        adjustedState = openTagsAt(prefix + candidateBody)
        chunk = prefix + candidateBody + closingTagsFor(adjustedState)
      }
      remaining = remaining.slice(adjustedCut)
      inherited = adjustedState
    } else {
      remaining = remaining.slice(cut)
      inherited = afterState
    }

    // Trim leading newlines on subsequent chunks (gateway.py paragraph split
    // does this implicitly — we do it explicitly). Prefix tags don't start
    // with \n so the regex is safe to run on the full chunk.
    if (chunks.length > 0) {
      chunk = chunk.replace(/^\n+/, '')
    }

    if (chunk.length > 0) chunks.push(chunk)
  }

  return chunks
}
