# pi-image-slim

[中文文档](./README.zh-CN.md)

A [Pi](https://pi.dev) extension that stops historical images from being re-uploaded on every request.

Screenshots are expensive. Once an image enters the conversation it is part of the request body forever, so a session that has read 30 MB of mockups uploads 30 MB on **every** turn. Prompt caching saves server-side compute, not bandwidth. On a slow uplink that is a minute of pure upload before the model even starts thinking.

`pi-image-slim` sends each image in full exactly once, then replaces it with a one-line placeholder that still names the file.

```
before   ████████████████████████████████████████  30.7 MB / request
                                                   (37 screenshots in history)
after    ████                                       3.1 MB / request
                                                   (only the current turn's image)
```

## Install

```bash
pi install npm:pi-image-slim
```

Or try it without touching your settings:

```bash
pi -e npm:pi-image-slim
```

## Who this is for

- You read screenshots, mockups, design references, or browser captures into Pi
- You work on a slow, metered, or proxied connection
- You see requests take tens of seconds while the model seems idle
- You noticed large upload traffic in your network monitor during a chat

If you only ever paste a single image and never look back, you do not need this.

## How it works

Two extension hooks:

**1. `tool_result`** — appends the file path to image results:

```
Read image file [image/png]
Image file: /Users/you/project/docs/mockups/title.png
```

The text stays in history forever. It is what lets the model find an image again after the pixels stop being sent.

**2. `before_provider_request`** — runs on the final serialized request body, one step before it goes on the wire. Every image that does not belong to the current turn is replaced with:

```
[image removed from history to save upload bandwidth: /Users/you/project/docs/mockups/title.png — re-read that file if you need to see it again]
```

Nothing else is touched. Session files, `models.json`, and your original images on disk are all left alone.

### Turn-based, not count-based

The boundary is **the last real user message**, not "the last N images".

- Read ten images in one turn → **all ten are sent in full.** The model can compare them.
- You type the next message → the previous turn's images become placeholders.
- The model wants to look again → it calls `read` on the path, and that image is uploaded again.

This matters because count-based rules silently drop images inside the turn that produced them. A rule like "keep the last 2 images" would send 2 of the 10 you just read.

### What the model sees, per turn

|                                     | Sent                           |
| ----------------------------------- | ------------------------------ |
| Images read in the current turn     | full image data                |
| Image you just pasted or dragged in | full image data                |
| Images from earlier turns           | placeholder with the file path |
| Everything else                     | unchanged                      |

## Measured

Real session, 37 screenshots read through `read`, ~30.7 MB of base64 history:

|                      | Request body | Upload at 500 KB/s |
| -------------------- | ------------ | ------------------ |
| No extension         | 30.7 MB      | ~61 s              |
| With `pi-image-slim` | 3.1 MB       | ~6 s               |

Processing cost of the pass itself: **under 1 ms** for a 30 MB body. It is pure object-pointer swapping — nothing is decoded, resized, or re-encoded, so there is no image-quality loss and no CPU spike.

## Compatibility

The placeholder's shape is chosen from the model's API, so switching providers does not produce an HTTP 400:

| API                                                                                | Placeholder part               |
| ---------------------------------------------------------------------------------- | ------------------------------ |
| `openai-completions`, `anthropic-messages`, `mistral-conversations`, `pi-messages` | `{ type: "text", text }`       |
| `openai-responses`, `azure-openai-responses`, `openai-codex-responses`             | `{ type: "input_text", text }` |
| `google-generative-ai`, `google-vertex`, `bedrock-converse-stream`                 | `{ text }`                     |

Image blocks are detected in all of those protocols, including images nested inside `tool_result` content.

## Caveats

- **Prompt cache churn.** When a new turn starts, one position in the body changes, so the server-side cache is invalidated from there on. The position is at the start of the current turn, i.e. near the end of the body, so the loss is small.
- **The model may not notice.** If the model answers from memory instead of re-reading a stale placeholder, its answer is based on a remembered image rather than the actual pixels. For pixel-level work, just ask it to look again — it will `read` the file.
- **Detection of the turn boundary uses Pi's serialization details** (the synthetic `Attached image(s) from tool result:` carrier message). If a future Pi release changes that shape, the extension degrades safely: it finds no boundary and strips nothing.
- **Disk usage is unchanged.** Session files still hold every image. This only reduces what goes over the wire.

## Disable

```bash
PI_IMAGE_SLIM=off pi
```

Or uninstall the package. Nothing is persisted anywhere, so removal leaves no traces.

## Development

```bash
git clone https://github.com/wiidede/pi-image-slim
cd pi-image-slim
pnpm install
pnpm test        # 18 tests, no network, no fixtures
pnpm check       # lint + typecheck + tests
```

The test suite covers turn scoping, per-protocol placeholder shapes, image detection across five protocol layouts, idempotency, malformed payloads, and a bandwidth comparison.

## License

MIT
