import { Buffer } from 'node:buffer'

/**
 * Image compression: PNG/JPEG in, WebP out.
 *
 * WebP is the only lossy format Pi and every major provider accept that also
 * beats JPEG on screenshots — measured 30-45% smaller on UI captures, and
 * roughly a tie on photographic content. AVIF would compress further but
 * Anthropic rejects it with a 400, and Pi rewrites unknown formats to PNG
 * (which inflates them), so it is not an option.
 *
 * `@jsquash` ships Emscripten modules that load their `.wasm` over `fetch()`.
 * Node has no `file://` fetch, so every codec is initialised from a compiled
 * `WebAssembly.Module` resolved through `require.resolve` instead.
 */

/** Structural stand-ins for the DOM types @jsquash exchanges. */
interface RawImage {
  data: Uint8ClampedArray
  width: number
  height: number
  colorSpace?: string
}

/** `WebAssembly.Module` without pulling in the DOM lib. */
interface CompiledWasm {
  readonly __wasmModule: unique symbol
}

// `lib.dom` declares the WebAssembly namespace; this project compiles against
// ES2023 only, so declare the single call used here.
declare const WebAssembly: {
  compile: (bytes: Uint8Array) => Promise<CompiledWasm>
}

type Decoder = (buffer: ArrayBuffer) => Promise<RawImage>
type Encoder = (image: RawImage, options: { quality: number }) => Promise<ArrayBuffer>
type Resizer = (
  image: RawImage,
  options: { width: number, height: number, method: 'triangle' },
) => Promise<RawImage>

interface Codecs {
  decodePng: Decoder
  decodeJpeg: Decoder
  resize: Resizer
  encodeWebp: Encoder
  /** Compile a `.wasm` file found next to the installed package. */
  compileWasm: (specifier: string) => Promise<CompiledWasm>
}

export interface CompressOptions {
  /**
   * Longest-edge ceiling. Resizing is applied to whichever of width or height is
   * larger, so tall phone screenshots shrink like wide desktop ones. Images that
   * are already within the ceiling are left at their original size.
   */
  maxEdge: number
  /** WebP quality, 0-100. */
  quality: number
}

export interface CompressedImage {
  data: string
  mimeType: 'image/webp'
  originalBytes: number
  bytes: number
  originalWidth: number
  originalHeight: number
  width: number
  height: number
}

let ready: Promise<Codecs> | undefined

/**
 * Load and initialise every codec exactly once per process.
 * `createRequire` is resolved against this module so it finds the extension's
 * own dependencies rather than the host's `node_modules`.
 */
function loadCodecs(): Promise<Codecs> {
  ready ??= (async () => {
    const { readFile } = await import('node:fs/promises')
    const { createRequire } = await import('node:module')
    const require = createRequire(import.meta.url)

    const compileWasm = async (specifier: string): Promise<CompiledWasm> =>
      WebAssembly.compile(await readFile(require.resolve(specifier))) as unknown as CompiledWasm

    const pngDecoder = await import('@jsquash/png/decode.js')
    const jpegDecoder = await import('@jsquash/jpeg/decode.js')
    const resizeModule = await import('@jsquash/resize')
    const webpEncoder = await import('@jsquash/webp/encode.js')

    await pngDecoder.init(await compileWasm('@jsquash/png/codec/pkg/squoosh_png_bg.wasm') as never)
    await jpegDecoder.init(await compileWasm('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm') as never)
    await resizeModule.initResize(await compileWasm('@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm') as never)
    await webpEncoder.init(await compileWasm('@jsquash/webp/codec/enc/webp_enc.wasm') as never)

    return {
      decodePng: pngDecoder.default as unknown as Decoder,
      decodeJpeg: jpegDecoder.default as unknown as Decoder,
      resize: resizeModule.default as unknown as Resizer,
      encodeWebp: webpEncoder.default as unknown as Encoder,
      compileWasm,
    }
  })()
  return ready
}

/**
 * Re-encode a PNG or JPEG as WebP, capping the longest edge.
 * Returns `undefined` when the input format is unsupported or the result would
 * not actually be smaller — callers keep the original in that case.
 *
 * `triangle` is deliberate: lanczos3 overshoots on the high-contrast text edges
 * that screenshots are full of, and those ringing artefacts cost more in WebP
 * bytes than the sharper kernel saves. Measured on real captures, triangle is
 * ~12% smaller than lanczos3 at the same quality.
 */
export async function compressImage(
  base64: string,
  mimeType: string,
  options: CompressOptions,
): Promise<CompressedImage | undefined> {
  let decode: Decoder | undefined
  try {
    const codecs = await loadCodecs()
    decode = mimeType === 'image/png'
      ? codecs.decodePng
      : mimeType === 'image/jpeg'
        ? codecs.decodeJpeg
        : undefined
    if (!decode)
      return undefined

    const original = Buffer.from(base64, 'base64')
    const buffer = original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength)
    const image = await decode(buffer)

    const longest = Math.max(image.width, image.height)
    const scale = Math.min(1, options.maxEdge / longest)
    const width = Math.round(image.width * scale)
    const height = Math.round(image.height * scale)
    const working = scale < 1
      ? await codecs.resize(image, { width, height, method: 'triangle' })
      : image

    const encoded = await codecs.encodeWebp(working, { quality: options.quality })
    const result = Buffer.from(encoded)
    // Re-encoding can lose: a small PNG may already beat WebP at this quality.
    if (result.length >= original.length)
      return undefined

    return {
      data: result.toString('base64'),
      mimeType: 'image/webp',
      originalBytes: original.length,
      bytes: result.length,
      originalWidth: image.width,
      originalHeight: image.height,
      width,
      height,
    }
  }
  catch {
    // Never break a tool result because compression failed.
    return undefined
  }
}
