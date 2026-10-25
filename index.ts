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
 *                                   edge), then ask the current model for a
 *                                   one-line description while the pixels are
 *                                   still visible. Write both the path and the
 *                                   description into a text note that stays in
 *                                   history.
 *   2. `before_provider_request` — the final serialized request body, one step
 *                                   before it goes on the wire. Images outside
 *                                   the newest `keepImages` image-bearing
 *                                   messages are replaced with a one-line text
 *                                   placeholder.
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
 *   still there after `/reload`, a restart, or compaction — unlike a side table
 *   keyed by image hash, which would silently degrade every old placeholder to a
 *   bare path. It also means the strip pass never has to read pixels back out of
 *   a provider payload, so it stays a pure pointer swap.
 *
 * A sliding window of messages
 *   The newest `keepImages` messages that carry an image are sent verbatim;
 *   everything older becomes a placeholder. Three consequences:
 *
 *   · A tool that returns ten screenshots puts them in one message, so they
 *     travel together — reading ten images in one call still shows all ten.
 *   · The window does not care whether the user spoke. That matters: an agent
 *     working on its own keeps one user message at index 0 for the whole loop,
 *     so a turn-based rule strips nothing there and re-uploads every screenshot
 *     on every step. Measured over a 30-step loop, that is 31 MB instead of 2 MB.
 *   · Nothing depends on how Pi serialises a turn. The window is just "messages
 *     that contain an image", counted from the end.
 *
 * Properties
 *   · Compression is best-effort: a failure, an unsupported format, or a result
 *     that is not smaller leaves the original bytes untouched.
 *   · Stripping is pure pointer swapping — a 30 MB body is processed in about a
 *     millisecond.
 *   · Idempotent: processing the same body twice changes nothing the second time.
 *   · Only the outbound request body is touched. Session files and `models.json`
 *     are never modified, so original images stay on disk and can be re-read.
 *   · Protocol-aware placeholder shape (chosen from `model.api`), so switching
 *     providers does not produce a 400.
 *   · Configure via `pi-image-slim.json` in the agent directory or `.pi/`. Each
 *     stage has its own switch, so you can compress without ever touching the
 *     context, or strip without compressing.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import type { ImageRef } from './protocol.ts'
import { captionImage } from './caption.ts'
import { DEFAULTS, loadConfig } from './config.ts'
import { compressImage } from './image.ts'
import {
  collectImageParts,
  isRecord,
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

/**
 * Read an `Image file:` / `Image description:` note out of a message.
 * Strings only — the walk never descends into a base64 payload's meaning, and it
 * stops at the first note it finds.
 */
function noteIn(message: unknown): ImageNote | undefined {
  const out: ImageNote = {}
  let done = false

  const walk = (node: unknown): void => {
    if (done)
      return
    if (typeof node === 'string') {
      for (const line of node.split('\n')) {
        const trimmed = line.trim()
        if (out.path === undefined && trimmed.startsWith(PATH_LINE)) {
          out.path = trimmed.slice(PATH_LINE.length).trim() || undefined
        }
        else if (out.caption === undefined && trimmed.startsWith(CAPTION_LINE)) {
          out.caption = trimmed.slice(CAPTION_LINE.length).trim() || undefined
        }
      }
      if (out.path !== undefined && out.caption !== undefined)
        done = true
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
  return out.path === undefined && out.caption === undefined
    ? undefined
    : out
}

/**
 * Look for a note in the image's own message first, then up to two messages back.
 *
 * The order matters. `openai-completions` hoists images into a synthetic user
 * message that follows the tool message, so the note is one step *back*.
 * `anthropic-messages` leaves the image inside the tool result, so the note is in
 * the *same* message — starting the search at `index - 1` would miss it and
 * silently drop both the path and the description.
 */
function nearbyNote(messages: unknown[], index: number): ImageNote | undefined {
  for (let i = index; i >= Math.max(0, index - 2); i--) {
    const found = noteIn(messages[i])
    if (found)
      return found
  }
  return undefined
}

// ─────────────────────────────────────────────────────────────
// Core pass
// ─────────────────────────────────────────────────────────────

/**
 * Replace every image outside the newest `keepImages` image-bearing messages
 * with a text placeholder, in place. Returns the number of images replaced.
 *
 * The unit is the *message*, not the image. A tool that returns ten screenshots
 * puts them all in one message, and they live or die together — so reading ten
 * images in one call still shows the model all ten.
 *
 * Counting messages instead of locating turn boundaries is what makes this hold
 * inside a single agent loop. `turnStart()` used to key on the last real user
 * message, which never moves while the agent works on its own, so a 30-step loop
 * kept every screenshot and re-uploaded the lot on every request. With a window,
 * each image is uploaded once and then dropped, whether or not the user spoke.
 */
export function stripOldImages(payload: unknown, api?: string, keepImages = DEFAULTS.keepImages): number {
  const messages = topLevelMessages(payload)
  if (!messages)
    return 0

  // One pass to find where the kept window begins.
  const carriers: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const refs: ImageRef[] = []
    collectImageParts(messages[i], refs)
    if (refs.length > 0)
      carriers.push(i)
  }
  if (carriers.length <= keepImages)
    return 0

  const keepFrom = carriers[carriers.length - keepImages]!

  let removed = 0
  for (let i = 0; i < keepFrom; i++) {
    const refs: ImageRef[] = []
    collectImageParts(messages[i], refs)
    if (refs.length === 0)
      continue

    const note = nearbyNote(messages, i)
    const text = placeholder(note?.path)
    for (const ref of refs) {
      ref.parent[ref.index] = {
        ...textPartFor(api, text),
      }
      removed++
    }
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

    // One note, written into the transcript so it survives reload and compaction.
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

    const removed = stripOldImages(event.payload, ctx.model?.api, config.keepImages)
    // Return undefined when nothing changed, so the body object is left alone.
    return removed > 0
      ? event.payload
      : undefined
  })
}
