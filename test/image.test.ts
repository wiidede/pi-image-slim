import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { captionImage } from '../caption.ts'
import { compressImage } from '../image.ts'

/**
 * A real screenshot shipped with the Pi package, so decoding, resizing and
 * encoding are exercised against actual PNG bytes rather than a synthetic stub.
 * The package blocks `package.json` through `exports`, so resolve the fixture
 * from the project's own `node_modules` directory instead.
 */
function realPng(name = 'tree-view.png'): { base64: string, bytes: number } {
  const url = new URL(
    `../node_modules/@earendil-works/pi-coding-agent/docs/images/${name}`,
    import.meta.url,
  )
  const buffer = readFileSync(url)
  return {
    base64: buffer.toString('base64'),
    bytes: buffer.length,
  }
}

describe('compressImage', () => {
  it('re-encodes a real PNG as smaller WebP', async () => {
    const { base64, bytes } = realPng()
    const result = await compressImage(base64, 'image/png', { maxEdge: 1440, quality: 75 })

    expect(result).toBeDefined()
    expect(result!.mimeType).toBe('image/webp')
    expect(result!.bytes).toBeLessThan(bytes)
    expect(result!.width).toBeLessThanOrEqual(1440)
    // WebP container magic: "WEBP" at byte offset 8.
    expect(Buffer.from(result!.data, 'base64').subarray(8, 12).toString('ascii')).toBe('WEBP')
  })

  it('caps the width and keeps the aspect ratio', async () => {
    const { base64 } = realPng()
    const result = await compressImage(base64, 'image/png', { maxEdge: 640, quality: 75 })

    expect(result!.width).toBe(640)
    expect(result!.originalWidth).toBeGreaterThan(640)
    const expected = Math.round((result!.originalHeight * 640) / result!.originalWidth)
    expect(result!.height).toBe(expected)
  })

  it('caps the longest edge, so portrait images shrink too', async () => {
    // interactive-mode.png is 1500x1736 — taller than wide. Capping width alone
    // would leave it untouched, which is the bug maxEdge exists to fix.
    const { base64 } = realPng('interactive-mode.png')
    const result = await compressImage(base64, 'image/png', { maxEdge: 640, quality: 75 })

    expect(result).toBeDefined()
    expect(result!.originalHeight).toBeGreaterThan(result!.originalWidth)
    expect(result!.height).toBe(640)
    expect(result!.width).toBeLessThan(640)
  })

  it('returns undefined for unsupported formats', async () => {
    const { base64 } = realPng()
    await expect(compressImage(base64, 'image/gif', { maxEdge: 1440, quality: 75 }))
      .resolves
      .toBeUndefined()
  })

  it('returns undefined instead of a larger payload', async () => {
    const { base64 } = realPng()
    // A tiny image cannot beat its own PNG bytes once resized down.
    const result = await compressImage(base64, 'image/png', { maxEdge: 1, quality: 100 })
    if (result)
      expect(result.bytes).toBeLessThan(Buffer.from(base64, 'base64').length)
  })

  it('never throws on corrupt data', async () => {
    await expect(compressImage('not-an-image', 'image/png', { maxEdge: 1440, quality: 75 }))
      .resolves
      .toBeUndefined()
  })

  it('degrades to undefined for jpeg input it cannot decode', async () => {
    await expect(compressImage('AAAA', 'image/jpeg', { maxEdge: 1440, quality: 75 }))
      .resolves
      .toBeUndefined()
  })
})

describe('captions', () => {
  it('normalises whitespace in the description', async () => {
    const ctx = {
      model: {
        input: ['text', 'image'],
      },
      modelRegistry: {
        complete: async () => ({
          content: [
            { type: 'text', text: '  A file  tree   view.  ' },
          ],
        }),
      },
    }

    const caption = await captionImage(ctx, { model: {}, base64: 'payload-1', mimeType: 'image/webp' })
    expect(caption).toBe('A file tree view.')
  })

  it('skips models without image input', async () => {
    let calls = 0
    const ctx = {
      model: {
        input: ['text'],
      },
      modelRegistry: {
        complete: async () => {
          calls++
          return { content: [] }
        },
      },
    }
    expect(await captionImage(ctx, { model: {}, base64: 'x', mimeType: 'image/webp' })).toBeUndefined()
    expect(calls).toBe(0)
  })

  it('swallows provider failures', async () => {
    const ctx = {
      model: {
        input: ['image'],
      },
      modelRegistry: {
        complete: async () => {
          throw new Error('boom')
        },
      },
    }
    expect(await captionImage(ctx, { model: {}, base64: 'y', mimeType: 'image/webp' })).toBeUndefined()
  })

  it('passes an abort signal so a slow provider can be cut off', async () => {
    let seen: AbortSignal | undefined
    const ctx = {
      model: {
        input: ['image'],
      },
      modelRegistry: {
        complete: async (_m: never, _c: never, options?: { signal?: AbortSignal }) => {
          seen = options?.signal
          return {
            content: [
              { type: 'text', text: 'ok' },
            ],
          }
        },
      },
    }

    await captionImage(ctx, {
      model: {},
      base64: 't1',
      mimeType: 'image/webp',
      timeoutMs: 5_000,
    })
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen!.aborted).toBe(false)
  })

  it('does not add a signal when the timeout is disabled', async () => {
    let seen: AbortSignal | undefined | 'missing' = 'missing'
    const ctx = {
      model: {
        input: ['image'],
      },
      modelRegistry: {
        complete: async (_m: never, _c: never, options?: { signal?: AbortSignal }) => {
          seen = options?.signal
          return {
            content: [
              { type: 'text', text: 'ok' },
            ],
          }
        },
      },
    }

    await captionImage(ctx, {
      model: {},
      base64: 't2',
      mimeType: 'image/webp',
      timeoutMs: 0,
    })
    expect(seen).toBeUndefined()
  })

  it('gives up when the timeout expires', async () => {
    let calls = 0
    const ctx = {
      model: {
        input: ['image'],
      },
      modelRegistry: {
        // Never settles on its own; only the timeout signal ends it.
        complete: async (_m: never, _c: never, options?: { signal?: AbortSignal }) => {
          calls++
          return new Promise<{ content: readonly { type: string, text?: string }[] }>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
        },
      },
    }

    const started = Date.now()
    const result = await captionImage(
      ctx,
      {
        model: {},
        base64: 'slow',
        mimeType: 'image/webp',
        timeoutMs: 30,
      },
    )

    expect(result).toBeUndefined()
    expect(calls).toBe(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('ignores an empty response', async () => {
    const ctx = {
      model: {
        input: ['image'],
      },
      modelRegistry: {
        complete: async () => ({
          content: [
            { type: 'text', text: '   ' },
          ],
        }),
      },
    }
    expect(await captionImage(ctx, { model: {}, base64: 'z', mimeType: 'image/webp' })).toBeUndefined()
  })
})
