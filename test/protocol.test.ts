import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import extension, { stripOldImages, turnStart } from '../index.ts'
import { collectImageParts, copyPayloadMessages, isImagePart, topLevelMessages } from '../protocol.ts'

// Fixtures follow Pi 1.3.0's provider converters. No model requests are made.
function png() {
  return {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
  }
}
function inline() {
  return {
    inlineData: { mimeType: 'image/png', data: 'AAAA' },
  }
}
const note = (path: string) => ({ type: 'text', text: `Image file: ${path}` })
function imageCount(value: unknown): number {
  const refs: Parameters<typeof collectImageParts>[1] = []
  collectImageParts(value, refs)
  return refs.length
}
const user = (text: string) => ({ role: 'user', content: text })
function googleUser(text: string) {
  return {
    role: 'user',
    parts: [
      { text },
    ],
  }
}
function googleResult(path: string, nested = false) {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          name: 'read',
          response: { output: `Image file: ${path}` },
          ...(nested
            ? {
                parts: [
                  inline(),
                ],
              }
            : {}),
        },
      },
    ],
  }
}
function googleCarrier() {
  return {
    role: 'user',
    parts: [
      { text: 'Tool result image:' },
      inline(),
    ],
  }
}
function openaiCarrier() {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'Attached image(s) from tool result:' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/png;base64,AAAA' },
      },
    ],
  }
}

const mergedLayouts = [
  {
    api: 'anthropic-messages',
    message: {
      role: 'user',
      content: ['/a.png', '/b.png'].map((path, i) => ({
        type: 'tool_result',
        tool_use_id: `c${i}`,
        content: [
          note(path),
          png(),
        ],
      })),
    },
  },
  {
    api: 'bedrock-converse-stream',
    message: {
      role: 'user',
      content: ['/a.png', '/b.png'].map((path, i) => ({
        toolResult: {
          toolUseId: `c${i}`,
          status: 'success',
          content: [
            { text: `Image file: ${path}` },
            {
              image: {
                format: 'png',
                source: {
                  bytes: new Uint8Array([1]),
                },
              },
            },
          ],
        },
      })),
    },
  },
]

describe('real provider turn layouts', () => {
  it.each([false, true])('keeps Google tools in the current turn (nested images: %s)', (nested) => {
    const contents: unknown[] = [
      googleUser('compare'),
      googleResult('/a.png', nested),
    ]
    if (!nested)
      contents.push(googleCarrier())
    contents.push({
      role: 'model',
      parts: [
        {
          functionCall: { name: 'bash', args: {} },
        },
      ],
    }, googleResult('/b.png'))
    const payload = { contents }
    expect(turnStart(contents, 1)).toBe(0)
    expect(stripOldImages(payload, 'google-generative-ai')).toBe(0)
    expect(imageCount(payload)).toBe(1)
  })

  it.each(mergedLayouts)('keeps merged $api tool results in the current turn', ({ api, message }) => {
    const payload = {
      messages: [
        user('compare'),
        structuredClone(message),
      ],
    }
    expect(stripOldImages(payload, api)).toBe(0)
    expect(imageCount(payload)).toBe(2)
  })

  it('counts a user text + image as a new turn across providers', () => {
    for (const content of [
      {
        content: [
          { type: 'text', text: 'compare this instead' },
          png(),
        ],
      },
      {
        content: [
          { type: 'input_text', text: 'compare this instead' },
          { type: 'input_image', image_url: 'data:x' },
        ],
      },
      {
        content: [
          { text: 'compare this instead' },
          {
            image: { format: 'png', source: {} },
          },
        ],
      },
      {
        parts: [
          { text: 'compare this instead' },
          inline(),
        ],
      },
    ]) {
      expect(turnStart([
        user('first'),
        { role: 'user', ...content },
      ], 1)).toBe(1)
    }
  })

  it('keeps ambiguous image-only messages rather than inventing a boundary', () => {
    expect(turnStart([
      user('first'),
      {
        role: 'user',
        content: [
          png(),
        ],
      },
    ], 1)).toBe(0)
  })

  it('supports the native pi-messages envelope and keepTurns', () => {
    const payload = {
      model: 'test',
      context: {
        messages: [
          user('first'),
          {
            role: 'toolResult',
            toolCallId: 'c1',
            content: [
              note('/a.png'),
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
          },
          user('second'),
          {
            role: 'toolResult',
            toolCallId: 'c2',
            content: [
              note('/b.png'),
              { type: 'image', data: 'BBBB', mimeType: 'image/png' },
            ],
          },
          user('third'),
        ],
      },
      options: {},
    }
    expect(stripOldImages(payload, 'pi-messages', 2)).toBe(1)
    expect(imageCount(payload)).toBe(1)
    expect(JSON.stringify(payload.context.messages[1])).toContain('Re-read /a.png')
  })

  it('keeps Google audio and video parts untouched', () => {
    for (const mimeType of ['audio/wav', 'video/mp4']) {
      expect(isImagePart({
        inlineData: { mimeType, data: 'AAAA' },
      })).toBe(false)
      expect(isImagePart({
        fileData: { mimeType, fileUri: 'gs://media' },
      })).toBe(false)
    }
    expect(isImagePart({
      fileData: { mimeType: 'image/png', fileUri: 'gs://image' },
    })).toBe(true)
  })
})

describe('individual image ownership', () => {
  it.each(mergedLayouts)('keeps each path in merged $api results', ({ api, message }) => {
    const payload = {
      messages: [
        user('first'),
        structuredClone(message),
        user('next'),
      ],
    }
    expect(stripOldImages(payload, api)).toBe(2)
    const content = payload.messages[1]!.content
    expect(JSON.stringify(content[0])).toContain('Re-read /a.png')
    expect(JSON.stringify(content[0])).not.toContain('Re-read /b.png')
    expect(JSON.stringify(content[1])).toContain('Re-read /b.png')
    expect(stripOldImages(payload, api)).toBe(0)
  })

  it.each(['google-generative-ai', 'google-vertex'])('writes nested placeholders into response JSON for %s', (api) => {
    const first = googleResult('/a.png', true).parts[0]!
    const second = googleResult('/b.png', true).parts[0]!
    const payload = {
      contents: [
        googleUser('first'),
        {
          role: 'user',
          parts: [first, second],
        },
        googleUser('next'),
      ],
    }
    expect(stripOldImages(payload, api)).toBe(2)
    const parts = payload.contents[1]!.parts
    expect(parts).toEqual([
      {
        functionResponse: {
          name: 'read',
          response: {
            output: expect.stringContaining('Re-read /a.png'),
          },
        },
      },
      {
        functionResponse: {
          name: 'read',
          response: {
            output: expect.stringContaining('Re-read /b.png'),
          },
        },
      },
    ])
    expect(imageCount(payload)).toBe(0)
    expect(stripOldImages(payload, api)).toBe(0)
  })

  it('preserves the newest Google tool images when the message cap is enabled', () => {
    const payload = {
      contents: [
        googleUser('first'),
        googleResult('/a.png', true),
        googleResult('/b.png', true),
        googleResult('/c.png', true),
      ],
    }
    expect(stripOldImages(payload, 'google-generative-ai', 1, 2)).toBe(1)
    expect(imageCount(payload)).toBe(2)
    expect(JSON.stringify(payload.contents[1])).toContain('Re-read /a.png')
    expect(stripOldImages(payload, 'google-generative-ai', 1, 2)).toBe(0)
  })

  it('preserves structured Google response values when adding a placeholder', () => {
    const response = {
      output: { width: 42 },
      extra: true,
    }
    const payload = {
      contents: [
        googleUser('first'),
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'screenshot',
                response,
                parts: [
                  inline(),
                ],
              },
            },
          ],
        },
        googleUser('next'),
      ],
    }
    expect(stripOldImages(payload, 'google-generative-ai')).toBe(1)
    expect(payload.contents[1]).toEqual({
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'screenshot',
            response: {
              ...response,
              imageHistory: expect.stringContaining('Re-attach it'),
            },
          },
        },
      ],
    })
    expect(response).toEqual({
      output: { width: 42 },
      extra: true,
    })
  })

  it('a user text + image closes the previous turn without removing the new attachment', () => {
    const payload = {
      messages: [
        user('first'),
        openaiCarrier(),
        {
          role: 'user',
          content: [
            note('/user.png'),
            {
              type: 'image_url',
              image_url: { url: 'data:new' },
            },
          ],
        },
      ],
    }
    expect(stripOldImages(payload, 'openai-completions')).toBe(1)
    expect(imageCount(payload.messages[1])).toBe(0)
    expect(imageCount(payload.messages[2])).toBe(1)
  })

  it('preserves non-image media and error response fields in Google results', () => {
    const audio = {
      inlineData: { mimeType: 'audio/wav', data: 'BBBB' },
    }
    const payload = {
      contents: [
        googleUser('first'),
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'read',
                response: { error: 'Image file: /a.png', code: 1 },
                parts: [
                  inline(),
                  audio,
                ],
              },
            },
          ],
        },
        googleUser('next'),
      ],
    }
    expect(stripOldImages(payload, 'google-generative-ai')).toBe(1)
    const text = JSON.stringify(payload)
    expect(text).toContain('Re-read /a.png')
    expect(text).toContain('"code":1')
    expect(text).toContain('audio/wav')
    expect(text).not.toContain('image/png')
  })

  it('does not give a pathless tool result its sibling path', () => {
    const payload = {
      messages: [
        user('first'),
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'a',
              content: [
                note('/a.png'),
                png(),
              ],
            },
            {
              type: 'tool_result',
              tool_use_id: 'b',
              content: [
                png(),
              ],
            },
          ],
        },
        user('next'),
      ],
    }
    stripOldImages(payload, 'anthropic-messages')
    const text = JSON.stringify(payload.messages[1])
    expect(text.match(/Re-read \/a.png/g)).toHaveLength(1)
    expect(text).toContain('Re-attach it')
  })

  it('does not borrow a nearby tool path for a user attachment', () => {
    const payload = {
      messages: [
        user('first'),
        { role: 'tool', content: 'Image file: /other.png' },
        {
          role: 'user',
          content: [
            png(),
          ],
        },
        user('next'),
      ],
    }
    stripOldImages(payload, 'anthropic-messages')
    expect(JSON.stringify(payload.messages[2])).toContain('Re-attach it')
  })

  it('does not assign one path to a multi-image result or conflicting notes', () => {
    for (const content of [
      [
        note('/a.png'),
        png(),
        png(),
      ],
      [
        note('/a.png'),
        note('/b.png'),
        png(),
      ],
    ]) {
      const payload = {
        messages: [
          user('first'),
          {
            role: 'user',
            content: [
              { type: 'tool_result', content },
            ],
          },
          user('next'),
        ],
      }
      stripOldImages(payload, 'anthropic-messages')
      expect(JSON.stringify(payload)).not.toContain('Re-read')
    }
  })

  it.each([false, true])('recovers a single OpenAI tool path (assistant bridge: %s)', (bridge) => {
    const messages: unknown[] = [
      user('first'),
      { role: 'tool', tool_call_id: 'a', content: 'Image file: /a.png' },
    ]
    if (bridge)
      messages.push({ role: 'assistant', content: 'I have processed the tool results.' })
    messages.push(openaiCarrier(), user('next'))
    stripOldImages({ messages }, 'openai-completions')
    expect(JSON.stringify(messages)).toContain('Re-read /a.png')
  })

  it('does not guess which merged OpenAI result owns the image', () => {
    const payload = {
      messages: [
        user('first'),
        { role: 'tool', tool_call_id: 'a', content: 'Image file: /a.png' },
        { role: 'tool', tool_call_id: 'b', content: 'Image file: /b.png' },
        openaiCarrier(),
        user('next'),
      ],
    }
    stripOldImages(payload, 'openai-completions')
    expect(JSON.stringify(payload.messages[3])).toContain('Re-attach it')
  })

  it('recovers a single lifted Google image path', () => {
    const payload = {
      contents: [
        googleUser('first'),
        googleResult('/a.png'),
        googleCarrier(),
        googleUser('next'),
      ],
    }
    stripOldImages(payload, 'google-generative-ai')
    expect(JSON.stringify(payload.contents[2])).toContain('Re-read /a.png')
  })

  it.each(['openai-responses', 'azure-openai-responses', 'openai-codex-responses'])('handles real function output arrays for %s', (api) => {
    const payload = {
      input: [
        user('first'),
        {
          type: 'function_call_output',
          call_id: 'a',
          output: [
            { type: 'input_text', text: 'Image file: /a.png' },
            { type: 'input_image', image_url: 'data:x' },
          ],
        },
        user('next'),
      ],
    }
    stripOldImages(payload, api)
    expect(payload.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'a',
      output: [
        { type: 'input_text', text: 'Image file: /a.png' },
        {
          type: 'input_text',
          text: expect.stringContaining('Re-read /a.png'),
        },
      ],
    })
  })

  it('handles Mistral tool content without changing its call identity', () => {
    const payload = {
      messages: [
        user('first'),
        {
          role: 'tool',
          toolCallId: 'a',
          name: 'read',
          content: [
            note('/a.png'),
            { type: 'image_url', imageUrl: 'data:x' },
          ],
        },
        user('next'),
      ],
    }
    stripOldImages(payload, 'mistral-conversations')
    expect(payload.messages[1]).toMatchObject({
      toolCallId: 'a',
      name: 'read',
      content: [
        note('/a.png'),
        {
          type: 'text',
          text: expect.stringContaining('Re-read /a.png'),
        },
      ],
    })
  })
})

describe('outbound-only replacement', () => {
  it.each(['openai-completions', 'pi-messages', 'google-generative-ai'])('copies changed ancestors and preserves source messages for %s', (api) => {
    const messages = api === 'google-generative-ai'
      ? [
          googleUser('first'),
          googleResult('/a.png', true),
          googleUser('next'),
        ]
      : [
          user('first'),
          {
            role: 'toolResult',
            content: [
              note('/a.png'),
              { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            ],
          },
          user('next'),
        ]
    const payload = api === 'pi-messages'
      ? {
          context: { messages },
          model: 'test',
        }
      : api === 'google-generative-ai'
        ? { contents: messages }
        : { messages }
    const before = structuredClone(payload)
    const out = copyPayloadMessages(payload)
    expect(stripOldImages(out, api)).toBe(1)
    expect(payload).toEqual(before)
    expect(imageCount(payload)).toBe(1)
    expect(imageCount(out)).toBe(0)
    expect(topLevelMessages(out)![0]).toBe(messages[0])
    expect(topLevelMessages(out)![1]).not.toBe(messages[1])
  })

  it('the request hook preserves a shared native session transcript', async () => {
    const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {}
    extension({
      on: (name: string, handler: never) => { handlers[name] = handler },
    } as never)
    const cwd = mkdtempSync(join(tmpdir(), 'pi-image-slim-native-'))
    try {
      mkdirSync(join(cwd, '.pi'))
      writeFileSync(join(cwd, '.pi', 'pi-image-slim.json'), JSON.stringify({ strip: true }))
      const messages = [
        user('first'),
        {
          role: 'toolResult',
          content: [
            note('/a.png'),
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
          ],
        },
        user('next'),
      ]
      const payload = {
        context: { messages },
        options: {},
        model: 'test',
      }
      const before = structuredClone(payload)
      const out = await handlers.before_provider_request!({ payload } as never, {
        cwd,
        model: { api: 'pi-messages' },
      } as never)
      expect(out).not.toBe(payload)
      expect(imageCount(out)).toBe(0)
      expect(payload).toEqual(before)
      expect(messages[1]!.content).toEqual(before.context.messages[1]!.content)
    }
    finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
