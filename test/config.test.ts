import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CONFIG_FILENAME, DEFAULTS, loadConfig } from '../config.ts'

let agentDir: string
let cwd: string

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), 'pi-image-slim-agent-'))
  cwd = mkdtempSync(join(tmpdir(), 'pi-image-slim-project-'))
})

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function writeUser(contents: unknown): void {
  writeFileSync(join(agentDir, CONFIG_FILENAME), JSON.stringify(contents))
}

function writeProject(contents: unknown): void {
  mkdirSync(join(cwd, '.pi'), { recursive: true })
  writeFileSync(join(cwd, '.pi', CONFIG_FILENAME), JSON.stringify(contents))
}

describe('loadConfig', () => {
  it('falls back to defaults when no file exists', () => {
    expect(loadConfig({ agentDir, cwd, env: {} })).toEqual(DEFAULTS)
  })

  it('reads the user-level file', () => {
    writeUser({ maxEdge: 1024, quality: 60 })
    const config = loadConfig({ agentDir, cwd, env: {} })
    expect(config.maxEdge).toBe(1024)
    expect(config.quality).toBe(60)
    expect(config.strip).toBe(true)
  })

  it('lets the project file refine the user file', () => {
    writeUser({ maxEdge: 1024, quality: 60, caption: false })
    writeProject({ maxEdge: 800 })
    const config = loadConfig({ agentDir, cwd, env: {} })
    expect(config.maxEdge).toBe(800)
    expect(config.quality).toBe(60)
    expect(config.caption).toBe(false)
  })

  it('lets compression stand alone, leaving context untouched', () => {
    writeUser({ strip: false, caption: false })
    const config = loadConfig({ agentDir, cwd, env: {} })
    expect(config.compress).toBe(true)
    expect(config.strip).toBe(false)
    expect(config.caption).toBe(false)
  })

  it('ignores unknown keys', () => {
    writeUser({ nope: 1, maxEdge: 900 })
    const config = loadConfig({ agentDir, cwd, env: {} })
    expect(config).toEqual({ ...DEFAULTS, maxEdge: 900 })
  })

  it('never accepts keepImages below 1, which would strip everything', () => {
    for (const bogus of [0, -1, 0.4]) {
      writeUser({ keepImages: bogus })
      expect(loadConfig({ agentDir, cwd, env: {} }).keepImages, String(bogus))
        .toBe(DEFAULTS.keepImages)
    }
  })

  it('reads a valid keepImages', () => {
    for (const value of [1, 3, 20]) {
      writeUser({ keepImages: value })
      expect(loadConfig({ agentDir, cwd, env: {} }).keepImages).toBe(value)
    }
    writeUser({ keepImages: 21 })
    expect(loadConfig({ agentDir, cwd, env: {} }).keepImages).toBe(DEFAULTS.keepImages)
  })

  it('ignores values of the wrong type or out of range', () => {
    writeUser({
      maxEdge: 'big',
      quality: 900,
      caption: 'yes',
      strip: 1,
    })
    expect(loadConfig({ agentDir, cwd, env: {} })).toEqual(DEFAULTS)
  })

  it('rounds fractional pixel widths', () => {
    writeUser({ maxEdge: 1440.4 })
    expect(loadConfig({ agentDir, cwd, env: {} }).maxEdge).toBe(1440)
  })

  it('lets compress and caption be toggled independently', () => {
    writeUser({ compress: false })
    let config = loadConfig({ agentDir, cwd, env: {} })
    expect(config.compress).toBe(false)
    expect(config.caption).toBe(true)

    writeUser({ compress: true, caption: false })
    config = loadConfig({ agentDir, cwd, env: {} })
    expect(config.compress).toBe(true)
    expect(config.caption).toBe(false)
  })

  it('accepts a caption timeout, including zero to disable it', () => {
    writeUser({ captionTimeoutMs: 1500 })
    expect(loadConfig({ agentDir, cwd, env: {} }).captionTimeoutMs).toBe(1500)

    writeUser({ captionTimeoutMs: 0 })
    expect(loadConfig({ agentDir, cwd, env: {} }).captionTimeoutMs).toBe(0)
  })

  it('rejects a negative caption timeout', () => {
    writeUser({ captionTimeoutMs: -1 })
    expect(loadConfig({ agentDir, cwd, env: {} }).captionTimeoutMs).toBe(DEFAULTS.captionTimeoutMs)
  })

  it('survives a malformed file', () => {
    writeFileSync(join(agentDir, CONFIG_FILENAME), '{ not json')
    expect(loadConfig({ agentDir, cwd, env: {} })).toEqual(DEFAULTS)
  })

  it('survives a file that is not an object', () => {
    writeFileSync(join(agentDir, CONFIG_FILENAME), '"just a string"')
    expect(loadConfig({ agentDir, cwd, env: {} })).toEqual(DEFAULTS)
  })

  it('has no environment override; disabling is Pi\'s job', () => {
    const config = loadConfig({
      agentDir,
      cwd,
      env: { PI_IMAGE_SLIM: 'off' },
    })
    expect(config).toEqual(DEFAULTS)
  })
})
