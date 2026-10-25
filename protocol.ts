/**
 * Everything protocol-specific, kept away from the strategy in `index.ts`.
 *
 * Pi serialises one conversation into at least five different wire shapes
 * (openai-completions, openai-responses, anthropic-messages, google, bedrock).
 * A placeholder written in the wrong shape is a hard 400 upstream, so the shape
 * is derived from `model.api` rather than assumed.
 *
 * This module only *locates* images and *writes* text parts. It never reads
 * pixels: captions live in the adjacent text, so the strip pass stays a pure
 * pointer swap and no base64 ever has to be parsed back out of a payload.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Text-block shape per API. Getting this wrong is a hard 400 upstream, so it is
 * derived from `model.api` rather than assumed to be `{ type: "text" }`.
 */
export function textPartFor(api: string | undefined, text: string): Record<string, unknown> {
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

/** Recognise an image block in any API Pi can emit. */
export function isImagePart(part: unknown): boolean {
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

/** Top-level message array: `messages` (openai), `input` (responses), `contents` (google). */
export function topLevelMessages(payload: unknown): unknown[] | undefined {
  if (!isRecord(payload))
    return undefined
  for (const key of ['messages', 'input', 'contents']) {
    const value = payload[key]
    if (Array.isArray(value))
      return value
  }
  return undefined
}

export interface ImageRef {
  /** The array the image block lives in. */
  parent: unknown[]
  /** Its index inside that array. */
  index: number
}

/**
 * Collect every image block below `node`, in document order.
 * Recursive on purpose: it covers `content[]`, anthropic's nested
 * `tool_result.content[]`, responses' `input[]`, and anything else Pi emits.
 */
export function collectImageParts(node: unknown, out: ImageRef[]): void {
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
