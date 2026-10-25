import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import extension, { captionWanted, stripOldImages } from '../index.ts'

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

/** Read a text block out of a payload without resorting to `any`. */
function textAt(payload: { messages: unknown[] }, m: number, ...path: (string | number)[]): string {
  let node: unknown = payload.messages[m]
  for (const key of path) {
    if (node === undefined || node === null)
      return ''
    node = (node as Record<string | number, unknown>)[key]
  }
  return (node as { text?: string } | undefined)?.text ?? ''
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

/** One tool call returning `count` images — they share a single message. */
function batchCycle(index: number, count: number, bytes = 1000, path = `/proj/batch${index}.png`): unknown[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: `c${index}`,
          type: 'function',
          function: { name: 'screenshot_all', arguments: '{}' },
        },
      ],
    },
    {
      role: 'tool',
      content: `Image file: ${path}`,
      tool_call_id: `c${index}`,
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Attached image(s) from tool result:' },
        ...Array.from({ length: count }, () => ({
          type: 'image_url',
          image_url: { url: `data:image/webp;base64,${fakeBase64(bytes)}` },
        })),
      ],
    },
  ]
}

/** A minimal newer image carrier, used to push an older one out of the window. */
function newerCarrier(): unknown {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'Attached image(s) from tool result:' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/webp;base64,BBBB' },
      },
    ],
  }
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

describe('keep window', () => {
  it('keeps every image when the window is not exceeded', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'hi' },
        ...batchCycle(0, 10),
      ],
    }
    const before = countImages(payload)
    expect(stripOldImages(payload, 'openai-completions')).toBe(0)
    expect(countImages(payload)).toBe(before)
  })

  it('keeps the whole batch a single tool call returned', () => {
    // Ten screenshots from one call share one message, so they live or die together.
    const payload = {
      messages: [
        { role: 'user', content: 'hi' },
        ...batchCycle(0, 10),
        ...batchCycle(1, 10),
      ],
    }
    // Two messages, window of 2 — nothing to do.
    expect(stripOldImages(payload, 'openai-completions', 2)).toBe(0)
    expect(countImages(payload)).toBe(20)
  })

  it('replaces images older than the window', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'hi' },
        ...batchCycle(0, 3),
        ...batchCycle(1, 2),
      ],
    }
    expect(stripOldImages(payload, 'openai-completions', 1)).toBe(3)
    expect(countPlaceholders(payload)).toBe(3)
    expect(countImages(payload)).toBe(2)
  })

  it('drops every image in a long agent loop, keeping only the window', () => {
    // The case the old turn-based rule missed: one user message, then many
    // autonomous steps. `turnStart()` never moved, so nothing was ever stripped
    // and every screenshot was re-uploaded on every step.
    const messages: unknown[] = [
      { role: 'user', content: 'fix the CSS everywhere' },
    ]
    let n = 0
    let totalSentBytes = 0
    const STEPS = 30
    for (let step = 0; step < STEPS; step++) {
      messages.push(...imageCycle(n++, 68_000))
      const payload = {
        messages: structuredClone(messages),
      }
      stripOldImages(payload, 'openai-completions', 2)
      totalSentBytes += sizeOf(payload)
    }
    // Ideal is 30 images × 68 KB sent once; a window of 2 costs at most 3x that.
    const ideal = STEPS * 68_000
    expect(totalSentBytes).toBeLessThan(ideal * 3)
    // The old behaviour was ~16x ideal.
    expect(totalSentBytes).toBeGreaterThan(ideal)
  })

  it('never strips the newest message, even with a window of 1', () => {
    const payload = payloadWith([
      { images: 1 },
      { images: 1 },
      { images: 1 },
    ])
    expect(stripOldImages(payload, 'openai-completions', 1)).toBe(2)
    expect(countImages(payload)).toBe(1)
  })

  it('names the right file in the placeholder', () => {
    const payload = payloadWith([
      { images: 2 },
      { images: 1 },
    ])
    stripOldImages(payload, 'openai-completions', 1)
    const serialized = JSON.stringify(payload)
    expect(serialized).toContain('Re-read /proj/img0.png')
    expect(serialized).toContain('Re-read /proj/img1.png')
    expect(serialized).not.toContain('Re-read /proj/img2.png')
  })

  it('strips nothing when the payload holds no messages', () => {
    expect(stripOldImages({}, 'openai-completions')).toBe(0)
    expect(stripOldImages({ messages: [] }, 'openai-completions')).toBe(0)
  })
})

describe('protocol shapes', () => {
  it('uses { type: \'text\' } for openai-completions', () => {
    const payload = payloadWith([
      { images: 1 },
      { images: 1 },
    ])
    stripOldImages(payload, 'openai-completions', 1)
    expect(JSON.stringify(payload)).toContain('{"type":"text","text":"[image removed')
  })

  it('uses { type: \'input_text\' } for openai-responses', () => {
    const payload = payloadWith([
      { images: 1 },
      { images: 1 },
    ])
    stripOldImages(payload, 'openai-responses', 1)
    expect(JSON.stringify(payload)).toContain('{"type":"input_text"')
  })

  it('uses a bare { text } for google and bedrock', () => {
    for (const api of ['google-generative-ai', 'bedrock-converse-stream']) {
      const payload = payloadWith([
        { images: 1 },
        { images: 1 },
      ])
      stripOldImages(payload, api, 1)
      expect(JSON.stringify(payload), api).toContain('{"text":"[image removed')
    }
  })

  it('falls back to { type: \'text\' } for an unknown api', () => {
    const payload = payloadWith([
      { images: 1 },
      { images: 1 },
    ])
    stripOldImages(payload, undefined, 1)
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
      // A second carrier of the same shape, so the window has something newer to
      // keep and the original becomes strippable.
      list.push(...structuredClone(list))
      list.push(trailingUser[name])
      const removed = stripOldImages(container, 'openai-completions', 1)
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
    expect(stripOldImages(payload, 'openai-completions', 1)).toBe(1)
    expect(JSON.stringify(payload)).toContain('Re-attach it')
  })
  it('reuses a note that sits in the same message (anthropic layout)', () => {
    // Regression: the note search used to start at index - 1, so anthropic's
    // tool_result — where the note and the image share one message — always
    // produced a pathless "Re-attach it" placeholder.
    const payload = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [
                { type: 'text', text: 'Image file: /tmp/shot.png\nImage description: A settings panel.' },
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/webp', data: 'AAAA' },
                },
              ],
            },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'ok' },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'next' },
          ],
        },
        newerCarrier(),
      ],
    }

    expect(stripOldImages(payload, 'anthropic-messages', 1)).toBe(1)
    const text = textAt(payload, 1, 'content', 0, 'content', 1)
    expect(text).toContain('Re-read /tmp/shot.png')
    expect(text).not.toContain('Re-attach')
  })

  it('reuses a note from the previous message (openai layout)', () => {
    const payload = payloadWith([
      { images: 1 },
      { images: 1 },
    ])
    expect(stripOldImages(payload, 'openai-completions', 1)).toBe(1)
    // The first carrier is [text header, placeholder]; its note came from the
    // tool message just before it.
    const carrier = payload.messages[4] as { content: { text?: string }[] }
    const texts = carrier.content.map(part => part.text ?? '')
    expect(texts.join('\n')).toContain('Re-read /proj/img0.png')
  })

  it('falls back to Re-attach when no path was ever recorded', () => {
    const payload = {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAAA' },
            },
          ],
        },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' },
        newerCarrier(),
      ],
    }
    expect(stripOldImages(payload, 'openai-completions', 1)).toBe(1)
    const text = textAt(payload, 1, 'content', 0)
    expect(text).toContain('Re-attach')
  })

  it('strips without ever parsing base64 out of the payload', () => {
    // The strip pass must stay a pointer swap. A data URL whose mime type is a
    // whole string (not one character) used to break the old regex parser, and
    // that parser existed only because captions lived in a hash-keyed table.
    const payload = {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/webp;base64,ZZZZ' },
            },
          ],
        },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'next' },
        newerCarrier(),
      ],
    }
    expect(stripOldImages(payload, 'openai-completions', 1)).toBe(1)
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
    stripOldImages(payload, 'openai-completions', 1)
    for (const message of payload.messages as { content: unknown }[]) {
      if (Array.isArray(message.content))
        expect(message.content.length).toBeGreaterThan(0)
    }
  })
})

describe('hooks', () => {
  it('skips the caption when stripping is off', () => {
    // With `strip: false` the image stays in context forever, so a description
    // would cost a round trip and a transcript note for nothing.
    expect(captionWanted({ caption: true, strip: true })).toBe(true)
    expect(captionWanted({ caption: true, strip: false })).toBe(false)
    expect(captionWanted({ caption: false, strip: true })).toBe(false)
  })

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

    const result = (await handlers.tool_result!(
      {
        input: { path: '/a/b.png' },
        content: [
          { type: 'image', data: 'AAA', mimeType: 'image/png' },
        ],
      } as never,
      { model: undefined } as never,
    )) as { content: { text?: string }[] } | undefined
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

describe('tool_result passthrough', () => {
  const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {}
  extension({
    on: (e: string, h: never) => {
      handlers[e] = h
      return () => {}
    },
  } as never)

  /** Run the hook against a temp project whose `.pi` config we control. */
  async function withConfig(
    config: Record<string, unknown>,
    event: Record<string, unknown>,
    ctx: Record<string, unknown> = {},
  ): Promise<Record<string, unknown> | undefined> {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-image-slim-hook-'))
    try {
      mkdirSync(join(cwd, '.pi'), { recursive: true })
      writeFileSync(join(cwd, '.pi', 'pi-image-slim.json'), JSON.stringify(config))
      return await handlers.tool_result!(
        {
          input: { path: '/a/b.png' },
          ...event,
        } as never,
        {
          cwd,
          model: {
            input: ['text', 'image'],
          },
          modelRegistry: {
            complete: async (_model: never, context: { messages: { content: { data: string }[] }[] }) => {
              const data = context.messages[0]!.content[0]!.data
              if (data === 'FAIL')
                throw new Error('caption failed')
              return {
                content: [
                  { type: 'text', text: `caption for ${data}` },
                ],
              }
            },
          },
          ...ctx,
        } as never,
      ) as Record<string, unknown> | undefined
    }
    finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  const imageEvent = {
    content: [
      { type: 'image', data: 'not-a-real-png', mimeType: 'image/png' },
    ],
  }

  it('writes no note at all when stripping is off', async () => {
    // With `strip: false` the image never leaves context, so a path note would
    // be permanent clutter. Compression still runs independently.
    const out = await withConfig({ strip: false, compress: false }, imageEvent)
    expect(out).toBeUndefined()
  })

  it('writes the path note when stripping is on', async () => {
    const out = await withConfig({ compress: false }, imageEvent)
    const texts = (out!.content as { type: string, text?: string }[])
      .filter(block => block.type === 'text')
      .map(block => block.text)
    // Single image: one note block, two lines.
    expect(texts).toEqual([
      'Image file: /a/b.png\nImage description: caption for not-a-real-png',
    ])
  })

  it('keeps details and structuredContent instead of blanking them', async () => {
    // Pi reads both off the hook result, so returning only `content` used to
    // wipe them for every image-bearing tool call.
    const details = {
      truncation: { truncated: false },
    }
    const structuredContent = { path: '/a/b.png', width: 64 }
    const out = await withConfig(
      { compress: false },
      { ...imageEvent, details, structuredContent },
    )
    expect(out!.details).toEqual(details)
    expect(out!.structuredContent).toEqual(structuredContent)
  })

  it('numbers descriptions when one call returns several images', async () => {
    const out = await withConfig(
      { compress: false },
      {
        input: { path: '/a/batch.png' },
        content: [
          { type: 'image', data: 'one', mimeType: 'image/png' },
          { type: 'image', data: 'two', mimeType: 'image/png' },
        ],
      },
    )
    const note = (out!.content as { type: string, text?: string }[])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(note).toContain('Image description: [1] caption for one')
    expect(note).toContain('Image description: [2] caption for two')
    // No Image file: line — one reported path cannot address two pictures.
    expect(note).not.toContain('Image file:')
    expect(note).toContain('2 images from one call')
  })

  it('keeps description slots aligned when one caption fails', async () => {
    // A failed caption used to be filtered out, shifting every later description
    // onto the wrong picture with no warning at all.
    const out = await withConfig(
      { compress: false },
      {
        input: {},
        content: [
          { type: 'image', data: 'one', mimeType: 'image/png' },
          { type: 'image', data: 'FAIL', mimeType: 'image/png' },
          { type: 'image', data: 'three', mimeType: 'image/png' },
        ],
      },
    )
    const note = (out!.content as { type: string, text?: string }[])
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(note).toContain('Image description: [1] caption for one')
    expect(note).toContain('Image description: [2] (no description)')
    expect(note).toContain('Image description: [3] caption for three')
  })

  it('leaves details alone when the result has none', async () => {
    const out = await withConfig({ compress: false }, imageEvent)
    expect('details' in out!).toBe(false)
    expect('structuredContent' in out!).toBe(false)
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
    stripOldImages(payload, 'openai-completions', 1)
    const after = sizeOf(payload)
    expect(before / after).toBeGreaterThan(3)
  })
})
