/** Provider-specific message layouts and copy-on-write image replacement. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Text-block shape per API. */
export function textPartFor(api: string | undefined, text: string): Record<string, unknown> {
  switch (api) {
    case 'openai-responses':
    case 'azure-openai-responses':
    case 'openai-codex-responses':
      return { type: 'input_text', text }
    case 'google-generative-ai':
    case 'google-vertex':
    case 'bedrock-converse-stream':
      return { text }
    default:
      return { type: 'text', text }
  }
}

/** Recognise images without treating Google's audio/video parts as images. */
export function isImagePart(part: unknown): boolean {
  if (!isRecord(part))
    return false
  if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image')
    return true
  for (const data of [part.inlineData, part.fileData]) {
    if (isRecord(data) && typeof data.mimeType === 'string' && data.mimeType.startsWith('image/'))
      return true
  }
  return part.type === undefined && isRecord(part.image)
}

/** Exact headers emitted by Pi for images lifted out of tool results. */
export function imageCarrierKind(message: unknown): 'openai' | 'google' | undefined {
  if (!isRecord(message) || message.role !== 'user')
    return undefined
  const first = Array.isArray(message.content)
    ? message.content[0]
    : undefined
  if (isRecord(first) && first.type === 'text' && first.text === 'Attached image(s) from tool result:')
    return 'openai'
  const part = Array.isArray(message.parts)
    ? message.parts[0]
    : undefined
  if (isRecord(part) && part.text === 'Tool result image:')
    return 'google'
  return undefined
}

/** Tool-generated user messages do not start a new user turn. */
export function isImageCarrier(message: unknown): boolean {
  if (!isRecord(message) || message.role !== 'user')
    return false
  if (imageCarrierKind(message))
    return true
  for (const list of [message.content, message.parts]) {
    if (!Array.isArray(list))
      continue
    if (list.some(part => isRecord(part) && (
      part.type === 'tool_result' || isRecord(part.functionResponse) || isRecord(part.toolResult)
    ))) {
      return true
    }
    // An image-only user message is ambiguous after provider conversion. Keep
    // it rather than risk treating an unknown synthetic message as a new turn.
    // User text + image, however, is a real boundary unless it has Pi's header.
    if (list.length > 0 && list.every(isImagePart))
      return true
  }
  return false
}

function messageContainer(payload: unknown): { parent: Record<string, unknown>, key: string } | undefined {
  if (!isRecord(payload))
    return undefined
  for (const key of ['messages', 'input', 'contents']) {
    if (Array.isArray(payload[key]))
      return { parent: payload, key }
  }
  if (isRecord(payload.context) && Array.isArray(payload.context.messages))
    return { parent: payload.context, key: 'messages' }
  return undefined
}

/** Includes pi-messages' native `{ context: { messages } }` envelope. */
export function topLevelMessages(payload: unknown): unknown[] | undefined {
  const container = messageContainer(payload)
  return container?.parent[container.key] as unknown[] | undefined
}

/** Copy only the envelope and message list; image ancestors are copied later. */
export function copyPayloadMessages(payload: unknown): unknown {
  const container = messageContainer(payload)
  if (!container || !isRecord(payload))
    return payload
  const messages = (container.parent[container.key] as unknown[]).slice()
  return container.parent === payload
    ? { ...payload, [container.key]: messages }
    : {
        ...payload,
        context: { ...container.parent, messages },
      }
}

export interface ImageRef {
  parent: unknown[]
  index: number
  /** The individual tool result that owns this image, if still identifiable. */
  scope?: Record<string, unknown>
}

/** Locate images and remember their nearest individual tool-result boundary. */
export function collectImageParts(node: unknown, out: ImageRef[], scope?: Record<string, unknown>): void {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i]
      if (isImagePart(item))
        out.push({ parent: node, index: i, scope })
      else collectImageParts(item, out, scope)
    }
    return
  }
  if (!isRecord(node))
    return
  if (node.type === 'tool_result' || node.type === 'function_call_output'
    || node.type === 'custom_tool_call_output' || node.role === 'tool' || node.role === 'toolResult') {
    scope = node
  }
  for (const [key, value] of Object.entries(node)) {
    collectImageParts(value, out, (key === 'functionResponse' || key === 'toolResult') && isRecord(value)
      ? value
      : scope)
  }
}

/** Copy changed ancestors only. Base64 strings and untouched objects are shared. */
export function replaceImageParts(node: unknown, replacements: ReadonlyMap<unknown, Record<string, unknown>>): unknown {
  const replacement = replacements.get(node)
  if (replacement)
    return replacement
  if (isImagePart(node))
    return node
  if (Array.isArray(node)) {
    let copy: unknown[] | undefined
    for (let i = 0; i < node.length; i++) {
      const next = replaceImageParts(node[i], replacements)
      if (next !== node[i]) {
        copy ??= node.slice()
        copy[i] = next
      }
    }
    return copy ?? node
  }
  if (!isRecord(node))
    return node
  let copy: Record<string, unknown> | undefined
  for (const [key, value] of Object.entries(node)) {
    const next = replaceImageParts(value, replacements)
    if (next !== value) {
      copy ??= { ...node }
      copy[key] = next
    }
  }
  return copy ?? node
}
