# pi-image-slim

[中文文档](./README.zh-CN.md)

A [Pi](https://pi.dev) extension that shrinks screenshots and stops old ones from being
re-uploaded.

## The problem

Pi sends the whole conversation with every request. Prompt caching makes that cheap for the
server, but not for your uplink — an image that entered the conversation is uploaded again on
**every single turn**, forever.

Read 30 MB of screenshots and you upload 30 MB per turn. On a 500 KB/s connection that is a
minute of uploading before the model even starts thinking.

## The fix

Two things happen, at two different moments. Each can be turned off on its own.

**When an image arrives**, it is compressed and described:

```
your screenshot  →  6.4x smaller WebP  +  one-line description
```

**Once it falls out of the window**, it is replaced by text:

```
[image removed from history to save upload bandwidth. Re-read /proj/title.png if you need to see it again.]
```

So each image is uploaded a small, bounded number of times, and what stays behind is a path
plus a description — enough for the model to know what the picture was, and to fetch it again
if it really needs to.

If you would rather keep every image in view, set `"strip": false`. You still get the 6.4x
compression, and the model never loses sight of anything.

## Install

```bash
pi install npm:pi-image-slim
```

Or try it without touching your settings:

```bash
pi -e npm:pi-image-slim
```

## Measured

Four real screenshots from Pi's own docs, compressed to 1280 px / WebP / quality 75:

| File | Before | After | |
| --- | --- | --- | --- |
| `tree-view.png` | 275 KB | 68 KB | 4.0x |
| `interactive-mode.png` | 506 KB | 84 KB | 6.0x |
| `exy.png` | 1475 KB | 179 KB | 8.2x |
| `doom-extension.png` | 167 KB | 44 KB | 3.7x |
| **total** | **2.4 MB** | **377 KB** | **6.4x** |

That saves bandwidth on the turn the image is sent, **and** disk space in the session file.
Stripping saves bandwidth on every turn after that.

## Who this is for

- You read screenshots, mockups, or browser captures into Pi
- You are on a slow, metered, or proxied connection
- Requests feel slow while the model seems idle

If you paste one image and never look back, you do not need this.

## How it works

Two hooks, nothing more.

**`tool_result`** — runs when a tool returns an image.

1. Re-encodes PNG/JPEG as WebP with the longest edge capped at `maxEdge` (`compress`).
2. Asks the current model to describe the stored bytes in one line (`caption`).
3. Writes both into the conversation as plain text:

```
Image file: /proj/docs/mockups/title.png
Image description: A dark settings panel with three toggles, the middle one off.
```

When one call returns several images, they are numbered instead, and no path is claimed —
Pi reports a single `path` for the whole call, so pointing every placeholder at it would send
the model to a file holding only one of the pictures:

```
Image batch: 2 images from one call, no single file to re-read.
Image description: [1] Header area: dark nav bar, a sign-in button on the right.
Image description: [2] Footer area: grey link list, copyright at the bottom.
```

Because this is ordinary transcript text, it survives `/reload`, restarts, and compaction.
The description is generated once, though its tokens are paid on every later request.

**`before_provider_request`** — runs on the finished request body, just before it goes out.

Every image outside the newest `keepImages` image-bearing messages becomes a placeholder
(`strip`). Nothing else is touched. This pass never decodes anything: it swaps object pointers, so a 30 MB body costs
about a millisecond.

### What the model sees

| | Sent |
| --- | --- |
| The newest `keepImages` messages that carry an image | full image |
| Anything older | placeholder + path |
| The description note | always |

### A window of messages, not of images

The last two image-bearing messages are sent in full; everything older is a placeholder.

- Ten screenshots from **one** tool call share one message, so all ten arrive in full and the
  model can compare them. The window counts messages, not pictures.
- Each new screenshot pushes the oldest one out. The image is still there in the description
  note, so the model knows what it was.
- The model needs another look → it `read`s the path, and that one image is uploaded again.

The window is why this also works inside a single long task. While the agent works on its own
there is no new user message, so a boundary based on "the last thing you typed" would never
move and every screenshot would be re-uploaded on every step. Measured over a 30-step loop at
68 KB per screenshot: **31 MB with a turn boundary, 4.1 MB with a window of 2** (ideal is 2 MB).

Set `"keepImages": 1` for the strictest version — each image is then uploaded exactly once.

### Why WebP

Measured on real screenshots it beats JPEG by 30-45% at the same visual quality, and roughly
ties on photos. AVIF compresses further but Anthropic rejects it with a 400, and Pi rewrites
unknown formats to PNG — which makes them bigger. Compression is best-effort: an unsupported
format, a failure, or a result that is not actually smaller all leave the original alone.

## Configuration

A JSON file, not environment variables. Two locations, most specific last:

| Path | Scope |
| --- | --- |
| `<agent-dir>/pi-image-slim.json` | every project (defaults to `~/.pi/agent`) |
| `.pi/pi-image-slim.json` | this project only |

```json
{
  "maxEdge": 1280,
  "quality": 75,
  "strip": true,
  "keepImages": 2
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `compress` | `true` | Re-encode PNG/JPEG as WebP |
| `caption` | `true` | Describe each image before the pixels go away |
| `strip` | `true` | Replace old images with a placeholder |
| `keepImages` | `2` | How many recent image messages stay intact (1-20) |
| `maxEdge` | `1280` | Ceiling for the **longer** side |
| `quality` | `75` | WebP quality, 0-100 |
| `captionTimeoutMs` | `20000` | Fall back to a bare path after this long; `0` = no limit |

Every key is optional. Unknown keys and bad values are ignored, and a malformed file falls
back to defaults instead of breaking tool results. Run `/reload` after editing.

### Pick your level

| `compress` | `strip` | What happens |
| --- | --- | --- |
| `true` | `true` | **Default.** Smaller images, old ones become text. |
| `true` | `false` | Images shrink ~6x, but the model keeps seeing all of them. |
| `false` | `true` | Full-size images, old ones become text. |

`"strip": false` changes nothing about the conversation — the model can always look back at
any image — while still cutting upload by about 84%. That is the safest setting if you are
unsure.

`caption` only does something while `strip` is on: an image that never leaves context does
not need a description, so the extra round trip is skipped automatically. `keepImages` below 1
is ignored, because the model has to be able to see the image it just asked for.

**Raise `maxEdge` if you work with small text** — 1568 is a common choice. Keep it at 2000 or
below: above that, Pi's own image normalisation re-encodes the result and throws the WebP
away.

**`maxEdge` measures the longer side**, so a 1200×4000 phone screenshot shrinks by its height
just like a wide desktop capture shrinks by its width.

## Disable

There is no `enabled` key and no environment variable. To turn it off, disable the extension
in your Pi config or uninstall it — one way instead of three.

## Compatibility

The placeholder shape is chosen from the model's API, so switching providers does not produce
a 400:

| API | Part |
| --- | --- |
| `openai-completions`, `anthropic-messages`, `mistral-conversations`, `pi-messages` | `{ type: "text", text }` |
| `openai-responses`, `azure-openai-responses`, `openai-codex-responses` | `{ type: "input_text", text }` |
| `google-generative-ai`, `google-vertex`, `bedrock-converse-stream` | `{ text }` |

Images are detected in all of them, including images nested inside `tool_result`.

## Caveats

- **Compression lowers resolution permanently.** Re-`read`ing the file will not bring back a
  detail — Pi applies the same resize every time. Raise `maxEdge` for small text.
- **A description can be wrong.** A confident but incorrect one is worse than none, because
  the model will reason from it. Descriptions come from the same model that already saw the
  image, and nothing is sent anywhere new, but they are not verified. Set
  `"caption": false` to turn them off.
- **A description is written once and never retried.** If that request times out, the
  placeholder stays path-only. Raise `captionTimeoutMs` to make that less likely.
- **Reading an image costs one extra model round trip**, because the description is generated
  before the tool result is committed. Images are handled one at a time, so ten images means
  ten round trips.
- **Prompt cache misses once**, on the turn after an image was read. The `tools` and `system`
  layers still hit; only `messages` is invalidated.
- **A batch of images cannot be re-read.** When one call returns several images, Pi reports one
  `path`, so none of them can claim it. The descriptions survive; the pixels do not.
- **The model may answer from the description instead of looking again.** For pixel-level
  work, ask it to re-`read` the file.
- **Old images are invisible to the model within a long task.** With a window of 2, a
  screenshot taken ten steps ago is a placeholder by the time the model wants to re-check it.
  The description is still there; the pixels are one `read` away. Raise `keepImages` if you
  work across many screenshots at once.
- **Old sessions are not retrofitted.** Only images read while the extension is active get
  compressed and described.
- **Session files still keep the compressed image**, not just the text. Stripping only
  affects what goes over the wire.

## Development

```bash
git clone https://github.com/wiidede/pi-image-slim
cd pi-image-slim
pnpm install
pnpm check       # lint + typecheck + tests
pnpm test        # 59 tests, no network, no fixtures
```

## License

MIT
