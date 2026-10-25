/**
 * pi-image-slim — stop historical images from being re-uploaded every turn.
 *
 * The problem
 *   `chat/completions` is stateless: every request is a full snapshot of the
 *   conversation. Once an image enters history, its base64 payload is re-sent on
 *   every subsequent turn. Prompt caching saves server-side compute, not
 *   bandwidth. A session that has read 30 MB of screenshots therefore uploads
 *   30 MB per turn — on a 500 KB/s uplink that is ~60 s of pure upload before the
 *   model even starts thinking.
 *
 * The fix (two hooks)
 *   1. `tool_result`             — append `Image file: <path>` to image results, so
 *                                   the model still knows where the file lives after
 *                                   the pixels stop being sent.
 *   2. `before_provider_request` — the final serialized request body, one step before
 *                                   it goes on the wire. Images that do not belong to
 *                                   the current turn are replaced with a one-line text
 *                                   placeholder that carries the original path.
 *
 * Turn-based, not count-based
 *   Everything after the last *real* user message belongs to the current turn and is
 *   sent verbatim — read ten images in one turn and the model sees all ten. Once the
 *   user speaks again, the previous turn's images become placeholders. Each image is
 *   therefore uploaded in full exactly once per session; the model re-`read`s a file
 *   only when it actually needs to look at it again.
 *
 * Properties
 *   · Pure pointer swaps — no decoding, no re-encoding. A 30 MB body is processed in
 *     well under a millisecond.
 *   · Idempotent: processing the same body twice changes nothing the second time.
 *   · Only the outbound request body is touched. Session files and `models.json` are
 *     never modified, so original images stay on disk and can always be re-read.
 *   · Protocol-aware placeholder shape (chosen from `model.api`), so switching
 *     providers does not produce a 400.
 *   · Disable at runtime with `PI_IMAGE_SLIM=off`. Delete the file to uninstall.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import process from 'node:process'

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

/**
 * Placeholder text. `path` is undefined for images that never had a file
 * (clipboard, drag & drop, most MCP screenshot tools).
 */
function placeholder(path?: string): string {
  return path
    ? `[image removed from history to save upload bandwidth: ${path} — re-read that file if you need to see it again]`
    : '[image removed from history to save upload bandwidth — re-attach it if you need to see it again]'
}

/** `PI_IMAGE_SLIM=off|0|false` disables the pass for the whole process. */
function isDisabled(): boolean {
  const value = process.env.PI_IMAGE_SLIM?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false'
}

// ─────────────────────────────────────────────────────────────
// Protocol shapes
// ─────────────────────────────────────────────────────────────

/**
 * Text-block shape per API. Getting this wrong is a hard 400 upstream, so it is
 * derived from `model.api` rather than assumed to be `{ type: "text" }`.
 */
function textPartFor(api: string | undefined, text: string): Record<string, unknown> {
  switch (api) {
    // OpenAI Responses family: the content item is called input_text
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
      return { type: 'input_text', text }
      // Google / Bedrock: the part is a bare { text }
    case 'google-generative-ai':
    case 'google-vertex':
    case 'bedrock-converse-stream':
      return { text }
      // openai-completions / anthropic-messages / mistral-conversations / pi-messages
    default:
      return { type: 'text', text }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Recognise an image block in any API Pi can emit. */
function isImagePart(part: unknown): boolean {
  if (!isRecord(part))
    return false
  // openai-completions / openai-responses
  if (part.type === 'image_url')
    return true
  // openai-responses
  if (part.type === 'input_image')
    return true
  // anthropic-messages (also covers images nested inside tool_result)
  if (part.type === 'image')
    return true
  // google
  if (isRecord(part.inlineData) || isRecord(part.fileData))
    return true
  // bedrock: { image: { format, source } }
  if (part.type === undefined && isRecord(part.image))
    return true
  return false
}

// ─────────────────────────────────────────────────────────────
// Structural traversal
// ─────────────────────────────────────────────────────────────

/** Top-level message array: `messages` (openai), `input` (responses), `contents` (google). */
function topLevelMessages(payload: unknown): unknown[] | undefined {
  if (!isRecord(payload))
    return undefined
  for (const key of ['messages', 'input', 'contents']) {
    const value = payload[key]
    if (Array.isArray(value))
      return value
  }
  return undefined
}

interface ImageRef {
  /** The array the image block lives in. */
  parent: unknown[]
  /** Its index inside that array. */
  index: number
}

/**
 * Collect every image block in one message, in document order.
 * Recursive on purpose: it covers `content[]`, anthropic's nested
 * `tool_result.content[]`, responses' `input[]`, and anything else Pi emits.
 */
function collectImageParts(node: unknown, out: ImageRef[]): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i]
      if (isImagePart(item))
        out.push({ parent: node, index: i })
      else collectImageParts(item, out)
    }
    return
  }
  if (!isRecord(node))
    return
  for (const value of Object.values(node)) collectImageParts(value, out)
}

/** Find an `Image file: <path>` line inside a message. Strings only — never base64. */
function imagePathIn(message: unknown): string | undefined {
  let found: string | undefined
  const walk = (node: unknown): void => {
    if (found !== undefined)
      return
    if (typeof node === 'string') {
      const match = node.match(/^Image file:(.*)$/m)
      if (match?.[1] !== undefined)
        found = match[1].trim() || undefined
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!isRecord(node))
      return
    for (const value of Object.values(node)) walk(value)
  }
  walk(message)
  return found
}

/**
 * Look back at most two messages for a path. Pi's layout is
 * `assistant(tool_calls) → tool(result) → user(image carrier)`, so two steps is
 * enough and bounded — a wider window could attach a neighbouring image's path.
 */
function nearbyPath(messages: unknown[], index: number): string | undefined {
  for (let i = index - 1; i >= Math.max(0, index - 2); i--) {
    const found = imagePathIn(messages[i])
    if (found)
      return found
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────
// Locating the current turn
// ─────────────────────────────────────────────────────────────

/**
 * Pi hoists images out of tool results into a synthetic `user` message
 * (`openai-completions`) or wraps them in a `tool_result` block
 * (`anthropic-messages`). Those are not real user input and must not be mistaken
 * for a turn boundary.
 */
function isImageCarrier(message: unknown): boolean {
  if (!isRecord(message) || message.role !== 'user')
    return false
  const content = message.content
  if (!Array.isArray(content))
    return false
  for (const part of content) {
    if (!isRecord(part))
      continue
    if (part.type === 'tool_result')
      return true
    if (part.type === 'text' && typeof part.text === 'string') {
      if (part.text.startsWith('Attached image(s) from tool result'))
        return true
      break
    }
  }
  return false
}

/**
 * Start of the current turn: the index of the last real user message.
 * Everything after it was produced by the agent within this turn and is sent
 * verbatim. Returns 0 when no boundary exists, which strips nothing — a safe
 * degradation.
 */
function turnStart(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (!isRecord(message) || message.role !== 'user')
      continue
    if (isImageCarrier(message))
      continue
    return i
  }
  return 0
}

// ─────────────────────────────────────────────────────────────
// Core pass
// ─────────────────────────────────────────────────────────────

/**
 * Replace every image that is not part of the current turn with a text
 * placeholder, in place. Returns the number of images replaced.
 */
export function stripOldImages(payload: unknown, api?: string): number {
  const messages = topLevelMessages(payload)
  if (!messages)
    return 0

  const keepFrom = turnStart(messages)
  if (keepFrom <= 0)
    return 0

  let removed = 0
  for (let i = 0; i < keepFrom; i++) {
    const refs: ImageRef[] = []
    collectImageParts(messages[i], refs)
    if (refs.length === 0)
      continue

    const text = textPartFor(api, placeholder(nearbyPath(messages, i)))
    for (const ref of refs) {
      ref.parent[ref.index] = { ...text }
      removed++
    }
  }
  return removed
}

// ─────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // ① Record the file path of every image result, so placeholders can point at it.
  pi.on('tool_result', async (event) => {
    const hasImage = event.content.some(block => block.type === 'image')
    if (!hasImage)
      return undefined

    // `read` uses `path`; several MCP tools use `file_path`.
    const rawPath = event.input.path ?? event.input.file_path
    if (typeof rawPath !== 'string' || rawPath.length === 0)
      return undefined

    // Idempotent: never append the same path twice.
    const already = event.content.some(
      block => block.type === 'text' && block.text.includes(rawPath),
    )
    if (already)
      return undefined

    return {
      content: [
        ...event.content,
        { type: 'text' as const, text: `Image file: ${rawPath}` },
      ],
    }
  })

  // ② One step before the request goes out, drop images from earlier turns.
  pi.on('before_provider_request', async (event, ctx) => {
    if (isDisabled())
      return undefined

    const removed = stripOldImages(event.payload, ctx.model?.api)
    // Return undefined when nothing changed, so the body object is left alone.
    return removed > 0
      ? event.payload
      : undefined
  })
}
