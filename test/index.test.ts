import { describe, expect, it } from 'vitest'
import extension, { stripOldImages } from '../index.ts'

// ─────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────

/** Synthesise a base64 blob of roughly `bytes` size. */
function fakeBase64(bytes: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes; i++) out += alphabet[i % 64]
  return out
}

const MB = 1_000_000
const sizeOf = (payload: unknown): number => JSON.stringify(payload).length
/** Each image block carries exactly one `"image_url":` key. */
function countImages(payload: unknown): number {
  return JSON.stringify(payload).split('"image_url":').length - 1
}
function countPlaceholders(payload: unknown): number {
  return JSON.stringify(payload).split('removed from history').length - 1
}

/** A read → tool result → image carrier cycle, the way Pi serialises it. */
function imageCycle(index: number, bytes = 1000, path = `/proj/img${index}.png`): unknown[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `c${index}`,
          type: 'function',
          function: {
            name: 'read',
            arguments: JSON.stringify({ path }),
          },
        },
      ],
    },
    {
      role: 'tool',
      content: `Read image file [image/png]\nImage file: ${path}`,
      tool_call_id: `c${index}`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Attached image(s) from tool result:' },
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${fakeBase64(bytes)}` },
        },
      ],
    },
  ]
}

function payloadWith(turns: { images: number, bytes?: number }[]): { messages: unknown[] } {
  const messages: unknown[] = [
    { role: 'system', content: 'sys' },
  ]
  let n = 0
  for (const [t, turn] of turns.entries()) {
    messages.push({ role: 'user', content: `turn ${t}` })
    for (let i = 0; i < turn.images; i++) messages.push(...imageCycle(n++, turn.bytes))
  }
  return { messages }
}

// ─────────────────────────────────────────────────────────────
// tests
// ─────────────────────────────────────────────────────────────

describe('turn scoping', () => {
  it('sends the current turn\'s images in full', () => {
    const payload = payloadWith([
      { images: 10 },
    ])
    const before = countImages(payload)
    expect(stripOldImages(payload, 'openai-completions')).toBe(0)
    expect(countImages(payload)).toBe(before)
  })

  it('replaces the previous turn\'s images with placeholders', () => {
    const payload = payloadWith([
      { images: 3 },
      { images: 2 },
    ])
    expect(stripOldImages(payload, 'openai-completions')).toBe(3)
    expect(countPlaceholders(payload)).toBe(3)
    expect(countImages(payload)).toBe(2)
  })

  it('uploads every image in full exactly once across a session', () => {
    // Simulate 5 consecutive requests, each appending one turn of 3 images.
    const messages: unknown[] = [
      { role: 'system', content: 'sys' },
    ]
    let n = 0
    let totalSentBytes = 0
    for (let turn = 0; turn < 5; turn++) {
      messages.push({ role: 'user', content: `turn ${turn}` })
      for (let i = 0; i < 3; i++) messages.push(...imageCycle(n++, 200_000))
      const payload = {
        messages: structuredClone(messages),
      }
      stripOldImages(payload, 'openai-completions')
      totalSentBytes += sizeOf(payload)
    }
    const fullySent = 15 * 200_000
    // 15 images × 200 KB sent once = 3 MB; plus the last turn re-sent a few times.
    expect(totalSentBytes).toBeLessThan(fullySent * 1.6)
  })

  it('names the right file in the placeholder', () => {
    const payload = payloadWith([
      { images: 2 },
      { images: 1 },
    ])
    stripOldImages(payload, 'openai-completions')
    const serialized = JSON.stringify(payload)
    expect(serialized).toContain(': /proj/img0.png —')
    expect(serialized).toContain(': /proj/img1.png —')
    expect(serialized).not.toContain(': /proj/img2.png —')
  })

  it('strips nothing when there is no real user message', () => {
    const payload = {
      messages: [
        ...imageCycle(0),
        ...imageCycle(1),
      ],
    }
    expect(stripOldImages(payload, 'openai-completions')).toBe(0)
  })

  it('opens a new turn for a user message carrying an image', () => {
    const payload = payloadWith([
      { images: 1 },
    ])
    payload.messages.push({
      role: 'user',
      content: [
        { type: 'text', text: 'and this one?' },
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,AAAA' },
        },
      ],
    })
    // The pasted image has no tool_result and no synthetic prefix, so it is real input.
    expect(stripOldImages(payload, 'openai-completions')).toBe(1)
    expect(countImages(payload)).toBe(1)
  })
})

describe('protocol shapes', () => {
  it('uses { type: \'text\' } for openai-completions', () => {
    const payload = payloadWith([
      { images: 1 },
      { images: 1 },
    ])
    stripOldImages(payload, 'openai-completions')
    expect(JSON.stringify(payload)).toContain('{"type":"text","text":"[image removed')
  })

  it('uses { type: \'input_text\' } for openai-responses', () => {
    const payload = payloadWith([
      { images: 1 },
      { images: 1 },
    ])
    stripOldImages(payload, 'openai-responses')
    expect(JSON.stringify(payload)).toContain('{"type":"input_text"')
  })

  it('uses a bare { text } for google and bedrock', () => {
    for (const api of ['google-generative-ai', 'bedrock-converse-stream']) {
      const payload = payloadWith([
        { images: 1 },
        { images: 1 },
      ])
      stripOldImages(payload, api)
      expect(JSON.stringify(payload), api).toContain('{"text":"[image removed')
    }
  })

  it('falls back to { type: \'text\' } for an unknown api', () => {
    const payload = payloadWith([
      { images: 1 },
      { images: 1 },
    ])
    stripOldImages(payload, undefined)
    expect(JSON.stringify(payload)).toContain('{"type":"text","text":"[image removed')
  })
})

describe('image detection across protocols', () => {
  it('detects every image block shape', () => {
    // Each payload holds one image in an earlier turn, then a real user message
    // that closes the turn — so the image is eligible for stripping.
    const trailingUser: Record<string, unknown> = {
      'openai-completions image_url': { role: 'user', content: 'next' },
      'openai-responses input_image': {
        role: 'user',
        content: [
          { type: 'input_text', text: 'next' },
        ],
      },
      'anthropic nested tool_result': {
        role: 'user',
        content: [
          { type: 'text', text: 'next' },
        ],
      },
      'google inlineData': {
        role: 'user',
        parts: [
          { text: 'next' },
        ],
      },
      'bedrock image block': { role: 'user', content: 'next' },
    }
    const shapes: Record<string, unknown> = {
      'openai-completions image_url': {
        messages: imageCycle(7, 100),
      },
      'openai-responses input_image': {
        input: [
          {
            type: 'function_call_output',
            output: [
              { type: 'input_image', image_url: 'data:x' },
            ],
          },
        ],
      },
      'anthropic nested tool_result': {
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 't1',
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', data: 'x' },
                  },
                ],
              },
            ],
          },
        ],
      },
      'google inlineData': {
        contents: [
          {
            role: 'user',
            parts: [
              {
                inlineData: { mimeType: 'image/png', data: 'x' },
              },
            ],
          },
        ],
      },
      'bedrock image block': {
        messages: [
          {
            role: 'user',
            content: [
              {
                image: { format: 'png', source: {} },
              },
            ],
          },
        ],
      },
    }
    for (const [name, payload] of Object.entries(shapes)) {
      const container = payload as Record<string, unknown>
      const list = (container.messages ?? container.input ?? container.contents) as unknown[]
      list.push(trailingUser[name])
      const removed = stripOldImages(container, 'openai-completions')
      expect(removed, name).toBeGreaterThan(0)
    }
  })

  it('gives clipboard images without a path the generic placeholder', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:x' },
            },
          ],
        },
        { role: 'user', content: 'next turn' },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:y' },
            },
          ],
        },
      ],
    }
    expect(stripOldImages(payload, 'openai-completions')).toBe(1)
    expect(JSON.stringify(payload)).toContain('re-attach it')
  })
})

describe('robustness', () => {
  it('is idempotent', () => {
    const payload = payloadWith([
      { images: 2 },
      { images: 2 },
    ])
    const first = stripOldImages(payload, 'openai-completions')
    const snapshot = JSON.stringify(payload)
    const second = stripOldImages(payload, 'openai-completions')
    expect(first).toBe(2)
    expect(second).toBe(0)
    expect(JSON.stringify(payload)).toBe(snapshot)
  })

  it('treats malformed payloads as safe no-ops', () => {
    for (const bad of [
      null,
      undefined,
      42,
      'text',
      [],
      {},
      { messages: 'not-an-array' },
    ]) {
      expect(stripOldImages(bad, 'openai-completions'), JSON.stringify(bad)).toBe(0)
    }
  })

  it('never leaves an empty content array behind', () => {
    const payload = {
      messages: [
        ...imageCycle(0, 50),
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'd' },
            },
          ],
        },
        { role: 'user', content: 'x' },
      ],
    }
    stripOldImages(payload, 'openai-completions')
    for (const message of payload.messages as { content: unknown }[]) {
      if (Array.isArray(message.content))
        expect(message.content.length).toBeGreaterThan(0)
    }
  })
})

describe('hooks', () => {
  it('registers both hooks and wires them up', async () => {
    const handlers: Record<string, (...args: never[]) => unknown> = {}
    const pi = {
      on: (event: string, handler: (...args: never[]) => unknown) => {
        handlers[event] = handler
        return () => {}
      },
    }
    extension(pi as never)
    expect(handlers.tool_result).toBeDefined()
    expect(handlers.before_provider_request).toBeDefined()

    const result = (await handlers.tool_result!({
      input: { path: '/a/b.png' },
      content: [
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
      ],
    } as never)) as { content: { text?: string }[] } | undefined
    expect(result).toBeDefined()
    expect(result!.content.at(-1)?.text).toBe('Image file: /a/b.png')

    const ctx = {
      model: { api: 'openai-completions' },
    }
    const payload = payloadWith([
      { images: 2 },
      { images: 1 },
    ])
    const out = await handlers.before_provider_request!({ payload } as never, ctx as never)
    expect(out).toBe(payload)
  })

  it('registers both hooks as async functions', () => {
    const handlers: Record<string, unknown> = {}
    extension({
      on: (e: string, h: unknown) => {
        handlers[e] = h
        return () => {}
      },
    } as never)
    for (const name of ['tool_result', 'before_provider_request']) {
      const fn = handlers[name] as (...a: never[]) => unknown
      expect(fn.constructor.name, name).toBe('AsyncFunction')
    }
  })
})

describe('bandwidth with realistic sizes', () => {
  it('collapses 30 MB of screenshots to one turn\'s worth', () => {
    const sizes = [
      3.42,
      3.06,
      3.01,
      2.84,
      2.6,
      2.56,
      1.82,
      1.32,
      1.21,
      1.15,
    ]
    const messages: unknown[] = [
      { role: 'system', content: 'sys' },
    ]
    let n = 0
    for (let turn = 0; turn < 4; turn++) {
      messages.push({ role: 'user', content: `turn ${turn}` })
      for (const mb of sizes.slice(turn * 2, turn * 2 + 2)) {
        messages.push(...imageCycle(n++, Math.round(mb * MB)))
      }
    }
    const payload = {
      messages: structuredClone(messages),
    }
    const before = sizeOf(payload)
    stripOldImages(payload, 'openai-completions')
    const after = sizeOf(payload)
    expect(before / after).toBeGreaterThan(3)
  })
})
