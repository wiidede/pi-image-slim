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
 *   1. `tool_result`             — re-encode every image as WebP (capped longest
 *                                   edge). When stripping is on, also ask the
 *                                   current model for a one-line description while
 *                                   the pixels are still visible, and write the path
 *                                   and description into a text note that stays in
 *                                   history.
 *   2. `before_provider_request` — the final serialized request body, one step
 *                                   before it goes on the wire. Images from turns
 *                                   older than the newest `keepTurns` are replaced
 *                                   with a one-line text placeholder.
 *
 * Two stages of reduction
 *   Compression shrinks each image by roughly 3-8x, which cuts upload bandwidth
 *   for the turn it is sent in. Stripping removes it from every later turn, which
 *   cuts it by the number of remaining turns. The note is what stops the second
 *   stage from destroying context: a path is an address, a description is
 *   information.
 *
 * Why the description lives in the transcript
 *   The note is ordinary message text, so it is persisted with the session and is
 *   still there after `/reload` or a restart — unlike a side table
 *   keyed by image hash, which would silently degrade every old placeholder to a
 *   bare path. It also means the strip pass never has to read pixels back out of
 *   a provider payload. Compaction may summarize or omit the note.
 *
 * A window of turns, not of messages
 *   Everything the agent produced since the newest `keepTurns` user messages were
 *   spoken is sent verbatim; images from older turns become placeholders. Four
 *   consequences:
 *
 *   · Reading ten screenshots in one turn keeps all ten visible for the rest of
 *     that turn. A count-based window got this wrong: the third screenshot pushed
 *     the first one out, in the middle of the task that needed both.
 *   · With the cap off, stripping does not change existing prefixes within a
 *     turn. Expiry changes the prefix at turn boundaries; actual cache reuse
 *     depends on the provider's rules and cache lifetime.
 *   · A turn boundary is a real user message. A tool that returns ten screenshots
 *     hoists them into a synthetic user message of their own, and turning that
 *     into a boundary would cut the turn in half, so carriers are skipped.
 *   · An agent working on its own never sees a new user message: the turn never
 *     ends, and a rule that only cuts at boundaries would strip nothing and
 *     re-upload every screenshot on every step (31 MB over a 30-step loop,
 *     measured). `maxKeptImages` is the answer, and it stays off by default — it
 *     buys bandwidth with cache misses, which is a trade only the user can price.
 *
 * Properties
 *   · Compression is best-effort: a failure, an unsupported format, or a result
 *     that is not smaller leaves the original bytes untouched.
 *   · Stripping copies changed object ancestors without decoding image data.
 *   · Idempotent: processing the same body twice changes nothing the second time.
 *   · Stripping only changes the outbound request. Compression changes images
 *     stored in the session; source image files are never modified.
 *   · Placeholder shapes and nested tool-result handling match the provider API.
 *   · Configure via `pi-image-slim.json` in the agent directory or `.pi/`. Each
 *     stage has its own switch, so you can compress without removing images,
 *     or strip without compressing.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ImageRef } from './protocol.ts'
import { captionImage } from './caption.ts'
import { DEFAULTS, loadConfig } from './config.ts'
import { compressImage } from './image.ts'
import {
  collectImageParts,
  copyPayloadMessages,
  imageCarrierKind,
  isImageCarrier,
  isImagePart,
  isRecord,
  replaceImageParts,
  textPartFor,
  topLevelMessages,
} from './protocol.ts'

/**
 * Image descriptions are only useful if the pixels are going to disappear. With
 * `strip: false` the image stays in context, so asking for a caption would be a
 * wasted round trip and a wasted note in the transcript.
 */
export function captionWanted(config: { caption: boolean, strip: boolean }): boolean {
  return config.caption && config.strip
}

/** Pi's own inline-image ceiling. Above it, Pi re-encodes whatever we produced. */
const PI_MAX_EDGE = 2000

/**
 * Placeholder text. `path` is undefined for images that never had a file
 * (clipboard, drag & drop, most MCP screenshot tools). The description is not
 * repeated here: it is already in the adjacent note, and repeating it would pay
 * those tokens on every request forever.
 */
function placeholder(path?: string): string {
  const tail = path
    ? ` Re-read ${path} if you need to see it again.`
    : ' Re-attach it if you need to see it again.'
  return `[image removed from history to save upload bandwidth.${tail}]`
}

/**
 * Pi has no per-image source metadata: `event.input` is one object of tool
 * arguments and `ImageContent` is just `{ data, mimeType }`. When a call returns
 * three images but reports one `path`, two of them have no address at all.
 *
 * The honest response is to keep the description but stop promising a re-read:
 * a placeholder that says `Re-read /x.png` for an image that is not in `/x.png`
 * is worse than one that says the image cannot be recovered.
 */

// ─────────────────────────────────────────────────────────────
// The durable note
// ─────────────────────────────────────────────────────────────

const PATH_LINE = 'Image file:'
const CAPTION_LINE = 'Image description:'
const BATCH_LINE = 'Image batch:'

export interface ImageNote {
  path?: string
  caption?: string
}

/** Read only tool-result text fields, never image bytes or tool arguments. */
function noteIn(scope: unknown): ImageNote | undefined {
  const paths = new Set<string>()
  let batch = false
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const line of node.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith(PATH_LINE)) {
          const path = trimmed.slice(PATH_LINE.length).trim()
          if (path)
            paths.add(path)
        }
        if (trimmed.startsWith(BATCH_LINE))
          batch = true
      }
      return
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    if (!isRecord(node) || isImagePart(node))
      return
    for (const key of [
      'text',
      'content',
      'output',
      'error',
      'response',
    ]) walk(node[key])
  }
  walk(scope)
  return !batch && paths.size === 1
    ? { path: paths.values().next().value }
    : undefined
}

/** Only borrow a note when lifted images have one unambiguous tool result. */
function carrierNote(messages: unknown[], index: number, imageCount: number): ImageNote | undefined {
  if (imageCount !== 1)
    return undefined
  const kind = imageCarrierKind(messages[index])
  if (kind === 'google') {
    const previous = messages[index - 1]
    if (!isRecord(previous) || !Array.isArray(previous.parts) || previous.parts.length !== 1)
      return undefined
    const part = previous.parts[0]
    return isRecord(part) && isRecord(part.functionResponse)
      ? noteIn(part.functionResponse)
      : undefined
  }
  if (kind !== 'openai')
    return undefined
  let end = index - 1
  const previous = messages[end]
  // Some OpenAI-compatible providers require this exact assistant bridge.
  if (isRecord(previous) && previous.role === 'assistant'
    && previous.content === 'I have processed the tool results.' && !previous.tool_calls) {
    end--
  }
  let start = end
  while (start >= 0) {
    const message = messages[start]
    if (!isRecord(message) || message.role !== 'tool')
      break
    start--
  }
  // OpenAI merges consecutive tool results into one image carrier. Multiple
  // results lose per-image ownership on the wire; do not guess at a path.
  return end - start === 1
    ? noteIn(messages[end])
    : undefined
}

// ─────────────────────────────────────────────────────────────
// Core pass
// ─────────────────────────────────────────────────────────────

/**
 * Index of the user message that opens the `keepTurns`-th newest turn. Everything
 * at or after it is sent verbatim. Returns 0 — strip nothing — when the history
 * holds fewer turns than that, which is also the safe answer when Pi's
 * serialisation stops looking the way this expects.
 */
export function turnStart(messages: unknown[], keepTurns: number): number {
  const starts: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (isRecord(message) && message.role === 'user' && !isImageCarrier(message))
      starts.push(i)
  }
  return starts.length < keepTurns
    ? 0
    : starts[starts.length - keepTurns]!
}

/**
 * Replace every image older than the kept turns with a text placeholder, in
 * place. Returns the number of images replaced.
 *
 * The unit is the *message*: a tool that returns ten screenshots puts them all in
 * one message, and they live or die together — reading ten images in one call
 * still shows the model all ten.
 */
export function stripOldImages(
  payload: unknown,
  api?: string,
  keepTurns = DEFAULTS.keepTurns,
  maxKeptImages = DEFAULTS.maxKeptImages,
): number {
  const messages = topLevelMessages(payload)
  if (!messages)
    return 0

  const carriers: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const refs: ImageRef[] = []
    collectImageParts(messages[i], refs)
    if (refs.length > 0)
      carriers.push(i)
  }
  if (carriers.length === 0)
    return 0

  let keepFrom = turnStart(messages, keepTurns)

  // The cap is off by default. When it is on it can only ever move the cut
  // forward, never back — it exists to bound a turn that never ends, not to
  // overrule the turns the user asked to keep.
  if (maxKeptImages > 0 && carriers.length > maxKeptImages)
    keepFrom = Math.max(keepFrom, carriers[carriers.length - maxKeptImages]!)

  if (keepFrom <= 0)
    return 0

  let removed = 0
  for (let i = 0; i < keepFrom; i++) {
    const refs: ImageRef[] = []
    collectImageParts(messages[i], refs)
    if (refs.length === 0)
      continue

    const liftedNote = carrierNote(messages, i, refs.length)
    const scopeCounts = new Map<Record<string, unknown>, number>()
    for (const ref of refs) {
      if (ref.scope)
        scopeCounts.set(ref.scope, (scopeCounts.get(ref.scope) ?? 0) + 1)
    }
    const replacements = new Map<unknown, Record<string, unknown>>()
    for (const ref of refs) {
      const note = ref.scope
        ? scopeCounts.get(ref.scope) === 1
          ? noteIn(ref.scope)
          : undefined
        : liftedNote
      replacements.set(ref.parent[ref.index], textPartFor(api, placeholder(note?.path)))
      removed++
    }
    // FunctionResponsePart accepts media only, not { text }. Move placeholders
    // into the response JSON instead of producing an invalid Gemini 3 request.
    if (api === 'google-generative-ai' || api === 'google-vertex') {
      for (const scope of scopeCounts.keys()) {
        if (!Array.isArray(scope.parts) || !isRecord(scope.response))
          continue
        const texts = scope.parts
          .filter(isImagePart)
          .map(part => replacements.get(part)?.text)
          .filter((text): text is string => typeof text === 'string')
        if (texts.length === 0)
          continue
        const { parts, ...rest } = scope
        const keptParts = (parts as unknown[]).filter(part => !isImagePart(part))
        const key = 'error' in scope.response
          ? 'error'
          : 'output'
        const original = scope.response[key]
        const response = typeof original === 'string'
          ? { ...scope.response, [key]: `${original}\n${texts.join('\n')}` }
          : {
              ...scope.response,
              imageHistory: texts.join('\n'),
            }
        replacements.set(scope, {
          ...rest,
          response,
          ...(keptParts.length > 0
            ? { parts: keptParts }
            : {}),
        })
      }
    }
    messages[i] = replaceImageParts(messages[i], replacements)
  }
  return removed
}

// ─────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  // Pi re-encodes anything above its own 2000px ceiling, throwing away our WebP.
  let warnedMaxEdge = false

  // ① Shrink every image a tool returns, then describe it while it is still visible.
  pi.on('tool_result', async (event, ctx) => {
    const images = event.content.filter(block => block.type === 'image')
    if (images.length === 0)
      return undefined

    const config = loadConfig({ cwd: ctx.cwd })

    // `read` uses `path`; several MCP tools use `file_path`.
    const rawPath = event.input.path ?? event.input.file_path
    const path = typeof rawPath === 'string' && rawPath.length > 0
      ? rawPath
      : undefined

    if (config.compress && config.maxEdge > PI_MAX_EDGE && !warnedMaxEdge) {
      warnedMaxEdge = true
      console.warn(
        `[pi-image-slim] maxEdge ${config.maxEdge} exceeds Pi's ${PI_MAX_EDGE}px inline ceiling; `
        + `Pi will re-encode the result and drop the WebP. Use ${PI_MAX_EDGE} or less.`,
      )
    }

    // Compress first: every later step, including the caption request, should
    // operate on the bytes that will actually live in history.
    const replace = new Map<unknown, { data: string, mimeType: string }>()
    if (config.compress) {
      for (const block of images) {
        const result = await compressImage(block.data, block.mimeType, {
          maxEdge: config.maxEdge,
          quality: config.quality,
        })
        if (result)
          replace.set(block, { data: result.data, mimeType: result.mimeType })
      }
    }

    const content = event.content.map((block) => {
      const next = replace.get(block)
      return next
        ? {
            ...block,
            ...next,
          }
        : block
    })

    // Caption the bytes that will actually live in history, so the description
    // matches the pixels the model saw. Requests are sequential on purpose: a
    // low-bandwidth link plus a shared relay is exactly where parallel uploads
    // and 429s hurt most.
    //
    // One entry per image, failures included. Filtering them out would shift
    // every later description onto the wrong picture without a word of warning.
    const captions: (string | undefined)[] = []
    if (captionWanted(config) && ctx.model) {
      for (const block of images) {
        const final = replace.get(block) ?? { data: block.data, mimeType: block.mimeType }
        captions.push(await captionImage(ctx, {
          model: ctx.model,
          base64: final.data,
          mimeType: final.mimeType,
          timeoutMs: config.captionTimeoutMs,
        }))
      }
    }

    // One note, written into the transcript so it survives reload and restarts.
    // Only when stripping is on: with `strip: false` the image stays in context
    // forever, so a path note would be permanent clutter nobody ever needs.
    const noteLines: string[] = []
    if (config.strip) {
      // A batch shares one reported path, and only the first image can claim it.
      // `stripOldImages` resolves one note per *message*, so writing the path here
      // would hand it to every image in the batch. Omit it and let the
      // placeholders say the images cannot be re-read, which is the truth.
      const single = images.length === 1
      if (path && single)
        noteLines.push(`${PATH_LINE} ${path}`)

      if (single) {
        const caption = captions[0]
        if (caption)
          noteLines.push(`${CAPTION_LINE} ${caption}`)
      }
      else {
        // Number them so each description stays traceable to its picture, and
        // keep a slot for the ones that failed instead of letting the rest shift.
        noteLines.push(
          path
            ? `${BATCH_LINE} ${images.length} images from one call, no single file to re-read.`
            : `${BATCH_LINE} ${images.length} images from one call, none of them re-readable.`,
        )
        for (const [i, caption] of captions.entries()) {
          noteLines.push(
            caption === undefined
              ? `${CAPTION_LINE} [${i + 1}] (no description)`
              : `${CAPTION_LINE} [${i + 1}] ${caption}`,
          )
        }
      }
    }

    const note = noteLines.join('\n')
    let changed = replace.size > 0
    if (note) {
      // Idempotent: never append the same note twice.
      const already = event.content.some(
        block => block.type === 'text' && block.text.includes(note),
      )
      if (!already) {
        content.push({ type: 'text' as const, text: note })
        changed = true
      }
    }
    if (!changed)
      return undefined

    // Pass the rest of the result through. Pi reads `details` and
    // `structuredContent` off the hook result, so returning only `content`
    // would blank them for every image-bearing tool call.
    return {
      content,
      ...(event.details === undefined
        ? {}
        : { details: event.details }),
      ...(event.structuredContent === undefined
        ? {}
        : { structuredContent: event.structuredContent }),
    }
  })

  // ② One step before the request goes out, drop images outside the keep window.
  pi.on('before_provider_request', async (event, ctx) => {
    const config = loadConfig({ cwd: ctx.cwd })
    if (!config.strip)
      return undefined

    // Native pi-messages payloads can share objects with session history.
    // Copy the envelope/list here; the strip pass copies changed ancestors only.
    const payload = copyPayloadMessages(event.payload)
    const removed = stripOldImages(
      payload,
      ctx.model?.api,
      config.keepTurns,
      config.maxKeptImages,
    )
    // Return undefined when nothing changed, so the body object is left alone.
    return removed > 0
      ? payload
      : undefined
  })
}
