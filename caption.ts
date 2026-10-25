/**
 * Image descriptions — the "compression" half that keeps meaning instead of pixels.
 *
 * Once an image leaves the current turn its bytes are dropped and only a
 * placeholder remains. A path is an address, not information: the model cannot
 * answer anything about the picture without spending a tool round trip (and
 * re-uploading the image) to `read` it again.
 *
 * So each image is described once, in the turn it was read, by the same model
 * that is about to look at it. Nothing leaves for a second endpoint, and a
 * description costs a few dozen tokens where the image cost thousands.
 *
 * There is deliberately no cache and no store here. The caller writes the
 * description into the transcript as message text, which is where it needs to be
 * anyway: a side table keyed by image hash would be lost on `/reload` and would
 * silently degrade every existing placeholder back to a bare path.
 */

const CAPTION_PROMPT = [
  'Describe the image for a future reader who can no longer see it.',
  'One or two sentences, under 40 words. Name the kind of image (screenshot, photo, diagram, chart),',
  'the main subject, and any text, labels, numbers, colours, or UI state that someone would likely ask about later.',
  'Do not speculate, do not describe how it was produced, and do not mention that it is an image.',
].join(' ')

/** The subset of `ExtensionContext` a caption needs, so this stays testable. */
export interface CaptionContext {
  model?: { input?: readonly string[] } | undefined
  signal?: AbortSignal | undefined
  modelRegistry: {
    complete: (
      model: never,
      context: never,
      options?: { signal?: AbortSignal },
    ) => Promise<{ content: readonly { type: string, text?: string }[] }>
  }
}

export interface CaptionRequest {
  model: unknown
  base64: string
  mimeType: string
  /** Abort the request after this many milliseconds. `0` means no limit. */
  timeoutMs?: number
}

/**
 * Combine the caller's signal with a timeout, so an aborted session and an
 * over-budget request both cancel the model call.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0)
    return signal
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!signal)
    return timeout
  return AbortSignal.any([signal, timeout])
}

/**
 * Ask the current model to describe one image.
 * Never rejects: a missing description only makes the placeholder less useful.
 */
export async function captionImage(ctx: CaptionContext, request: CaptionRequest): Promise<string | undefined> {
  // A model without image input cannot describe one.
  if (!ctx.model?.input?.includes('image'))
    return undefined

  try {
    const response = await ctx.modelRegistry.complete(
      request.model as never,
      {
        systemPrompt: CAPTION_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', data: request.base64, mimeType: request.mimeType },
              { type: 'text', text: 'Describe this image.' },
            ],
            timestamp: Date.now(),
          },
        ],
      } as never,
      {
        signal: withTimeout(ctx.signal, request.timeoutMs ?? 0),
      } as never,
    )

    const text = response.content
      .filter(part => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text!.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')

    return text || undefined
  }
  catch {
    // Timeout, abort, provider error, malformed response — all mean the same
    // thing to a caller: fall back to a bare path placeholder.
    return undefined
  }
}
