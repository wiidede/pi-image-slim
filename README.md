# pi-image-slim

[中文文档](./README.zh-CN.md)

A [Pi](https://pi.dev) extension that shrinks images, and optionally stops old ones from being
re-uploaded.

## The problem

Pi sends the whole conversation with every request. Prompt caching makes that cheap for the
server, but not for your uplink — an image that entered the conversation is uploaded again on
**every single turn**, forever.

Read 30 MB of images and you upload 30 MB per turn. On a 500 KB/s connection that is a
minute of uploading before the model even starts thinking.

## The fix

Two things can happen, at two different moments. The first is on by default; the second is
opt-in.

**When a tool returns an image**, it is compressed:

```
your image  →  6.4x smaller WebP
```

**Once its turn is over**, it can be replaced by text (`"strip": true`):

```
[image removed from history to save upload bandwidth. Re-read /proj/title.png if you need to see it again.]
```

Compression reduces resolution and uses lossy WebP encoding. It can save substantial bandwidth,
but small text and fine lines may lose detail. Replacement changes the history visible to the
model, so it ships off and you decide. While an image is inside the kept window it is still
uploaded with every request; once it expires, a placeholder and any available path and
description remain.

## Install

```bash
pi install npm:pi-image-slim
```

Or try it without touching your settings:

```bash
pi -e npm:pi-image-slim
```

## Measured

Four real images from Pi's own docs, compressed to 1280 px / WebP / quality 75:

| File | Before | After | |
| --- | --- | --- | --- |
| `tree-view.png` | 275 KB | 68 KB | 4.0x |
| `interactive-mode.png` | 506 KB | 84 KB | 6.0x |
| `exy.png` | 1475 KB | 179 KB | 8.2x |
| `doom-extension.png` | 167 KB | 44 KB | 3.7x |
| **total** | **2.4 MB** | **377 KB** | **6.4x** |

That saves bandwidth on the turn the image is sent, **and** disk space in the session file.
Stripping, when you turn it on, saves bandwidth on every turn after that.

## Who this is for

- You read images into Pi — screenshots, mockups, browser captures
- You are on a slow, metered, or proxied connection
- Requests feel slow while the model seems idle

If you paste one image and never look back, you do not need this.

## How it works

Two hooks, nothing more.

**`tool_result`** — runs when a tool returns an image.

1. Re-encodes PNG/JPEG as WebP with the longest edge capped at `maxEdge` (`compress`).
2. If stripping is on, asks the current model to describe the stored bytes in one line
   (`caption`).
3. Writes the path and that description into the conversation as plain text:

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

Because this is ordinary transcript text, it survives `/reload` and restarts. After compaction,
which details remain depends on the summary.
The description is generated once, though its tokens are paid on every later request. With
stripping off none of this is written: an image that never leaves context needs no address and
no description, so that round trip is skipped too.

**`before_provider_request`** — runs on the finished request body, just before it goes out.

Images outside the kept turns become placeholders (`strip`). This pass never decodes image
data and copies only changed object ancestors, preserving images in session history. Gemini 3
function-response media arrays do not accept text parts, so their placeholders are added to
the same function response's JSON text instead.

### What the model sees

| | Sent |
| --- | --- |
| Every image read since you last spoke | full image |
| Images from earlier turns | placeholder + path |
| The description note | always |
| Nothing at all, with `strip: false` (the default) | full image, forever |

### A window of turns, not of images

Everything the agent has produced since you last spoke is sent verbatim. When you speak again,
the previous turn's images become placeholders and the new turn starts clean. `keepTurns`
(default `1`) moves that boundary further back.

- Ten images in **one** turn stay visible for the whole turn, however many tool calls they
  came from. A count-based window got this wrong: the third one pushed the first one
  out in the middle of the task that needed both.
- The model needs another look → it `read`s the path, and that one image is uploaded again.
- With the image-count cap disabled, stripping does not change an existing prefix *within*
  a turn, which helps prompt-cache reuse. Expiring images changes the prefix; actual cache
  hits depend on provider rules, cache lifetime, and other request changes.

The catch: an agent working on its own sees no new user message, so the turn never ends
and turn-based stripping does not apply. For a 30-step loop at 68 KB per image, estimated
cumulative image upload is **31 MB** (about 2 MB if each were sent once). `maxKeptImages` is
the escape hatch, and stays at `0` — no cap — because cutting inside a turn changes the
cache prefix more frequently. Set it to 6–8 on a slow link and the same loop is about 11–14 MB.

### Why WebP

Measured on real interface images it beats JPEG by 30-45% at the same visual quality, and roughly
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
  "strip": false,
  "keepTurns": 1,
  "maxKeptImages": 0
}
```

| Key | Default | Meaning |
| --- | --- | --- |
| `compress` | `true` | Re-encode PNG/JPEG as WebP |
| `caption` | `true` | Describe each image before the pixels go away (only used while `strip` is on) |
| `strip` | `false` | Replace old images with a placeholder |
| `keepTurns` | `1` | How many recent turns keep their images (1-20) |
| `maxKeptImages` | `0` | Cap on image-bearing messages, even inside a kept turn; `0` = no cap |
| `maxEdge` | `1280` | Ceiling for the **longer** side |
| `quality` | `75` | WebP quality, 0-100 |
| `captionTimeoutMs` | `20000` | Fall back to a bare path after this long; `0` = no limit |

Every key is optional. Unknown keys and bad values are ignored, and a malformed file falls
back to defaults instead of breaking tool results. Run `/reload` after editing.

0.1.x's `keepImages` is gone. It counted messages rather than turns, so it is ignored instead
of being reinterpreted as `maxKeptImages` — that would quietly impose a cap nobody asked for.

### Pick your level

| `compress` | `strip` | What happens |
| --- | --- | --- |
| `true` | `false` | **Default.** Images shrink ~6x, and the model keeps seeing all of them. |
| `true` | `true` | Smaller images, and old ones become text. |
| `false` | `true` | Full-size images, old ones become text. |

The default keeps every image visible, but the images themselves are compressed with loss.
The four samples above use about 84% fewer image bytes; savings and detail loss
vary with the image. Turn `strip` on when you need to reduce historical image uploads further.

`caption` only does something while `strip` is on: an image that never leaves context does
not need a description, so the extra round trip is skipped automatically. `keepTurns` below 1
is ignored, because the model has to be able to see the image it just asked for.

**Raise `maxEdge` if you work with small text** — 1568 is a common choice. Keep it at 2000 or
below: above that, Pi's own image normalisation re-encodes the result and throws the WebP
away.

**`maxEdge` measures the longer side**, so a 1200×4000 portrait phone image shrinks by its height
just like a wide desktop one shrinks by its width.

## Disable

There is no `enabled` key and no environment variable. To turn it off, disable the extension
in your Pi config or uninstall it — one way instead of three.

## Compatibility

The placeholder shape is chosen from the model's API:

| API | Part |
| --- | --- |
| `openai-completions`, `anthropic-messages`, `mistral-conversations`, `pi-messages` | `{ type: "text", text }` |
| `openai-responses`, `azure-openai-responses`, `openai-codex-responses` | `{ type: "input_text", text }` |
| `google-generative-ai`, `google-vertex`, `bedrock-converse-stream` | `{ text }` |

Supported layouts include nested tool results and pi-messages' `context.messages` envelope.
For Google's `functionResponse.parts`, expired images are removed and placeholders are added
to the function response's `response` JSON; text blocks are never inserted into its media array.

Paths come from the individual tool result that owns an image. When OpenAI merges images
from several tool results and ownership is ambiguous, placeholders omit re-read paths. The
original path and description notes remain.

## Caveats

- **Compression and captions only run on images a tool returns.** `ctrl+v` is not an
  exception: Pi writes the clipboard image to a temp file and inserts that path into the
  editor, so the model `read`s it and that read is a tool result. An image attached straight
  to a message — the RPC `images` field, or `@shot.png` in the first prompt — bypasses both
  stages, but can still be stripped once old when `strip` is on.
- **Compression loses detail.** Source files are unchanged, but session history stores the
  compressed image. Re-`read`ing with the same settings compresses it again. Raise `maxEdge`
  for small text, or turn `compress` off.
- **A description can be wrong.** A confident but incorrect one is worse than none, because
  the model will reason from it. Descriptions come from the same model that already saw the
  image, and nothing is sent anywhere new, but they are not verified. Set
  `"caption": false` to turn them off.
- **A description is written once and never retried.** If that request times out, the
  placeholder stays path-only. Raise `captionTimeoutMs` to make that less likely.
- **With `strip` and `caption` on, each tool image costs an extra model round trip**, because
  the description is generated before the tool result is committed. Images are handled one at
  a time, so ten images means ten round trips.
- **Stripping changes the cache prefix.** Turn-based stripping limits changes within a turn;
  setting `maxKeptImages` can change it more often. Cache reuse and costs depend on the provider.
- **A batch of images cannot be re-read.** When one call returns several images, Pi reports one
  `path`, so none of them can claim it. The descriptions survive; the pixels do not.
- **The model may answer from the description instead of looking again.** For pixel-level
  work, ask it to re-`read` the file.
- **A long task keeps every image it reads**, because the turn never ends. That is the price of
  the cache-friendly cut. Lower `maxKeptImages` if the uploads hurt more than the misses.
- **Turn boundaries depend on Pi's serialization.** Recognized tool results and synthetic
  image messages do not start turns; user text plus images does. Ambiguous image-only messages
  do not start turns either, which can retain extra old images. Future Pi layout changes
  require compatibility review.
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
pnpm test        # offline; reads Pi's bundled sample images and creates/cleans temporary config files
```

## License

MIT
