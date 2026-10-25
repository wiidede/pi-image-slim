# pi-image-slim

[English](./README.md)

一个 [Pi](https://pi.dev) 扩展：压缩截图，并让旧图不再反复重传。

## 问题

Pi 每次请求都会把整个对话发一遍。prompt cache 让服务端算起来便宜，但省不了你的上行带宽——一张图一旦进了对话，之后**每一轮**都会被重新上传，永远如此。

读了 30 MB 截图，就是每轮上传 30 MB。在 500 KB/s 的链路上，模型还没开始思考，光上传就要一分钟。

## 做法

两个时刻，各做一件事，两件都能单独关掉。

**图片进来时**，压缩并描述：

```
你的截图  →  小 6.4 倍的 WebP  +  一句描述
```

**等它被挤出窗口后**，它被替换成文字：

```
[image removed from history to save upload bandwidth. Re-read /proj/title.png if you need to see it again.]
```

于是每张图的上传次数是有界的、很少的几次，留下的是路径加描述——够模型知道那张图是什么，也够它真需要时再取回来。

如果你更希望所有图片一直可见，设 `"strip": false`。照样能得到 6.4 倍的压缩，而且模型什么都不会丢。

## 安装

```bash
pi install npm:pi-image-slim
```

或者不改配置先试试：

```bash
pi -e npm:pi-image-slim
```

## 实测

Pi 官方文档里的四张真实截图，压到 1280 px / WebP / 质量 75：

| 文件 | 压缩前 | 压缩后 | |
| --- | --- | --- | --- |
| `tree-view.png` | 275 KB | 68 KB | 4.0x |
| `interactive-mode.png` | 506 KB | 84 KB | 6.0x |
| `exy.png` | 1475 KB | 179 KB | 8.2x |
| `doom-extension.png` | 167 KB | 44 KB | 3.7x |
| **合计** | **2.4 MB** | **377 KB** | **6.4x** |

这既省了图片被发送那一轮的带宽，**也**省了会话文件的磁盘空间。剥离则省掉之后每一轮的带宽。

## 适合谁

- 你会把截图、设计稿、浏览器抓图读进 Pi
- 你在用慢速、计费或需要代理的网络
- 你感觉请求很慢，但模型看起来在发呆

如果你只是偶尔贴一张图就再也不看，那不需要装这个。

## 它怎么工作

两个钩子，没有别的。

**`tool_result`** —— 工具返回图片时触发。

1. 把 PNG/JPEG 重新编码成 WebP，最长边限制在 `maxEdge`（`compress`）。
2. 让当前模型对"真正会被存下来的那份字节"写一句描述（`caption`）。
3. 两者都作为普通文本写进对话：

```
Image file: /proj/docs/mockups/title.png
Image description: A dark settings panel with three toggles, the middle one off.
```

一次调用返回多张图时，描述会带序号，而且**不写路径**——Pi 对整次调用只报一个 `path`，把它写给每张图会让占位符指向一个只含其中一张的文件：

```
Image batch: 2 images from one call, no single file to re-read.
Image description: [1] Header 区域：深色导航栏，右侧一个登录按钮。
Image description: [2] Footer 区域：灰色链接列表，版权信息在底部。
```

因为这就是普通的对话记录，它能挺过 `/reload`、进程重启和上下文压缩。描述只生成一次，但它的 token 每轮都要重付。

**`before_provider_request`** —— 在请求体组装完、还没发出去的一刻触发。

最近 `keepImages` 条带图消息之外的图片都变成占位符，其它什么都不动。这一遍**不解码任何数据**，只是替换对象指针，30 MB 的请求体大约一毫秒。

### 模型每轮看到什么

| | 发送内容 |
| --- | --- |
| 最近 `keepImages` 条带图消息 | 完整图片 |
| 更早的 | 占位符 + 路径 |
| 那条描述 note | 始终保留 |

### 窗口按消息算，不按图片算

最近两条带图消息完整发送，更早的变成占位符。

- **一次**工具调用返回的十张截图共享同一条消息，所以十张都完整送达，模型可以互相对比。窗口数的是消息，不是张数。
- 每来一张新截图，最老的那条被挤出去。图虽然没了，描述还在，模型仍知道它是什么。
- 模型要再看 → 它对路径 `read` 一次，那一张图会被重新上传。

这个窗口也是它能在一个长任务里生效的原因。agent 自己干活时不会有新的用户消息，所以"以你最后一次发言为界"这条规则永远不会移动，每一步都会把所有截图重传一遍。实测 30 步、每步一张 68 KB 截图：**按轮划分是 31 MB，窗口为 2 是 4.1 MB**（理想值 2 MB）。

想要最严格就把 `"keepImages"` 设成 `1`——那样每张图确实只上传一次。

### 为什么是 WebP

在真实截图上实测，同视觉质量下比 JPEG 小 30–45%，照片类内容则大致持平。AVIF 能再小些，但 Anthropic 直接 400 拒绝，而 Pi 会把不认识的格式重写成 PNG——反而更大。压缩是尽力而为的：不支持的格式、失败、或者结果没变小，都保持原字节不动。

## 配置

用 JSON 文件，不用环境变量。两个位置，越靠后优先级越高：

| 路径 | 作用范围 |
| --- | --- |
| `<agent-dir>/pi-image-slim.json` | 所有项目（默认为 `~/.pi/agent`） |
| `.pi/pi-image-slim.json` | 仅当前项目 |

```json
{
  "maxEdge": 1280,
  "quality": 75,
  "strip": true,
  "keepImages": 2
}
```

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `compress` | `true` | 把 PNG/JPEG 重新编码成 WebP |
| `caption` | `true` | 像素丢掉之前先写一句描述 |
| `strip` | `true` | 把旧图换成占位符 |
| `keepImages` | `2` | 保留最近几条带图消息（1–20） |
| `maxEdge` | `1280` | **较长边**的上限 |
| `quality` | `75` | WebP 质量，0–100 |
| `captionTimeoutMs` | `20000` | 超过这么久就退回纯路径；`0` 表示不限时 |

所有键都可选。未知的键和不合法的值会被忽略，文件格式坏了也只是退回默认值，不会弄坏工具结果。改完记得 `/reload`。

### 选一个档位

| `compress` | `strip` | 效果 |
| --- | --- | --- |
| `true` | `true` | **默认。** 图片变小，旧的变成文字。 |
| `true` | `false` | 图片小 6 倍左右，但模型始终能看到全部图片。 |
| `false` | `true` | 原图尺寸，旧的变成文字。 |

`"strip": false` **完全不影响对话内容**——模型随时能回头看任何一张图——但上行带宽仍然能省大约 84%。拿不定主意时，选这个最稳。

`caption` 只在 `strip` 开着时才有意义：永远不会离开上下文的图，不需要描述，所以那次额外的模型往返会自动跳过。`keepImages` 小于 1 会被忽略——模型总得能看见它刚要求的那张图。

**如果常看小字，把 `maxEdge` 调大** —— 1568 是常见选择。但别超过 2000：超过之后 Pi 自己的图片归一化会把结果重新编码，我们生成的 WebP 就白做了。

**`maxEdge` 量的是较长边**，所以 1200×4000 的手机竖屏截图按高度缩，和宽屏截图按宽度缩是一个道理。

## 关闭

没有 `enabled` 键，也没有环境变量。想关掉就在 Pi 的配置里禁用这个扩展，或者直接卸载——只有一种方式，而不是三种。

## 兼容性

占位符的形状按模型的 API 生成，所以换供应商不会 400：

| API | 形状 |
| --- | --- |
| `openai-completions`、`anthropic-messages`、`mistral-conversations`、`pi-messages` | `{ type: "text", text }` |
| `openai-responses`、`azure-openai-responses`、`openai-codex-responses` | `{ type: "input_text", text }` |
| `google-generative-ai`、`google-vertex`、`bedrock-converse-stream` | `{ text }` |

这些协议里的图片都能认出来，包括嵌在 `tool_result` 里的。

## 注意事项

- **压缩会永久降低分辨率。** 重新 `read` 也找不回细节——Pi 每次读都会应用同样的缩放。需要看清小字就调大 `maxEdge`。
- **描述可能是错的。** 一句自信但错误的描述比没有更糟，因为模型会照着它推理。描述由本来就要看这张图的模型当场生成，也没发给任何新的端点，但**没有被验证过**。设 `"caption": false` 可以关掉。
- **批量返回的图无法重新读取。** 一次调用返回多张图时，Pi 只报一个 `path`，所以它们谁也用不上。描述还在，像素没了。
- **长任务里旧的图对模型是不可见的。** 窗口为 2 时，十步之前的截图早就变成占位符了。描述还在，像素只差一次 `read`。如果你经常要同时对照很多张图，把 `keepImages` 调大。
- **描述只生成一次，不会重试。** 如果那次请求超时，占位符就永远是纯路径。调大 `captionTimeoutMs` 可以降低概率。
- **读一张图会多一次模型往返**，因为描述要在工具结果落盘前生成。图片是一张一张处理的，读十张就是十次往返。
- **prompt cache 会 miss 一次**，发生在图片被读进来的下一轮。`tools` 和 `system` 层仍然命中，只有 `messages` 失效。
- **模型可能照描述回答，而不是重新看图。** 做像素级的工作时，直接让它再 `read` 一次那个文件。
- **轮次边界的判断依赖 Pi 的序列化细节**（那条合成的 `Attached image(s) from tool result:` 消息）。如果未来的 Pi 改了形状，扩展会安全降级：找不到边界，就什么都不剥离。
- **旧会话不会被追溯处理。** 只有扩展启用期间读进来的图才会被压缩和描述。
- **会话文件里仍然保留压缩后的图片**，不只是文字。剥离只影响线上传输的部分。

## 开发

```bash
git clone https://github.com/wiidede/pi-image-slim
cd pi-image-slim
pnpm install
pnpm check       # lint + typecheck + 测试
pnpm test        # 59 个测试，不联网，不依赖磁盘文件
```

## License

MIT
