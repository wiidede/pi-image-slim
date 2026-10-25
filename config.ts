/**
 * Settings, read from a JSON file rather than the environment.
 *
 * Pi has no per-extension settings namespace, so an extension-owned file is the
 * convention (pi-web-access, pi-mcp-adapter and others do the same). Two
 * locations are read, most specific first:
 *
 *   1. `<agent-dir>/pi-image-slim.json`  — user-wide
 *   2. `.pi/pi-image-slim.json`          — this project
 *
 * Later files refine earlier ones, so the project file wins.
 *
 * Keys match the documented configuration table. Everything is optional, and a
 * missing or malformed file falls back to the defaults — this extension failing
 * to read its own config must never stop a tool result from being produced.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { CONFIG_DIR_NAME, getAgentDir } from '@earendil-works/pi-coding-agent'

export interface ImageSlimConfig {
  /** Re-encode PNG/JPEG as WebP before they enter history. */
  compress: boolean
  /** Ask the current model to describe each image before the pixels are dropped. */
  caption: boolean
  /** Replace images from earlier turns with a text placeholder. */
  strip: boolean
  /**
   * How many of the newest image-bearing messages stay in full. Everything older
   * becomes a placeholder. At least one is always kept: the model has to be able
   * to see the image it just asked for.
   */
  keepImages: number
  /** Longest edge kept when re-encoding. Applies to the longer of width/height. */
  maxEdge: number
  /** WebP quality, 0-100. */
  quality: number
  /** Give up on a caption after this many milliseconds and fall back to a bare path. */
  captionTimeoutMs: number
}

export const DEFAULTS: ImageSlimConfig = {
  compress: true,
  caption: true,
  strip: true,
  keepImages: 2,
  maxEdge: 1280,
  quality: 75,
  captionTimeoutMs: 20_000,
}

export const CONFIG_FILENAME = 'pi-image-slim.json'

type RawConfig = Record<string, unknown>

function readJson(path: string): RawConfig | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? parsed as RawConfig
      : undefined
  }
  catch {
    return undefined
  }
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean'
    ? value
    : undefined
}

function asInteger(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return undefined
  const rounded = Math.round(value)
  return rounded >= min && rounded <= max
    ? rounded
    : undefined
}

/** Merge one raw object over the config so far, ignoring unknown or invalid keys. */
function apply(config: ImageSlimConfig, raw: RawConfig): ImageSlimConfig {
  return {
    compress: asBoolean(raw.compress) ?? config.compress,
    caption: asBoolean(raw.caption) ?? config.caption,
    strip: asBoolean(raw.strip) ?? config.strip,
    keepImages: asInteger(raw.keepImages, 1, 20) ?? config.keepImages,
    maxEdge: asInteger(raw.maxEdge, 1, 20_000) ?? config.maxEdge,
    quality: asInteger(raw.quality, 0, 100) ?? config.quality,
    captionTimeoutMs: asInteger(raw.captionTimeoutMs, 0, 600_000) ?? config.captionTimeoutMs,
  }
}

/**
 * Resolve configuration for the current process.
 * There is no master `enabled` switch and no environment override: turning this
 * extension off is Pi's job (disable it in your Pi config, or uninstall it), so
 * there is exactly one way to do it instead of three.
 */
export function loadConfig(options: {
  cwd?: string
  agentDir?: string
  env?: NodeJS.ProcessEnv
} = {}): ImageSlimConfig {
  const agentDir = options.agentDir ?? getAgentDir()
  const cwd = options.cwd ?? process.cwd()

  let config = { ...DEFAULTS }

  // User-wide first, then the project file refines it.
  const user = readJson(join(agentDir, CONFIG_FILENAME))
  if (user)
    config = apply(config, user)

  const project = readJson(join(cwd, CONFIG_DIR_NAME, CONFIG_FILENAME))
  if (project)
    config = apply(config, project)

  return config
}
