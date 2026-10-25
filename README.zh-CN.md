# pi-image-slim

[English](./README.md)

一个 [Pi](https://pi.dev) 扩展：让历史上的图片不再在每一轮请求里被重复上传。

截图很贵。一张图一旦进入对话，它就永远留在请求体里，所以一个读过 30 MB 设计稿的会话，**每一轮**都要上传 30 MB。prompt cache 省的是服务端算力，不省带宽。在慢速上行链路上，这意味着模型还没开始思考，就已经过去了整整一分钟。

`pi-image-slim` 让每张图只在**它被读进来的那一轮**完整发送一次，之后替换成一行仍然带着文件路径的占位符。

```
改之前   █████████████████████████████████████████  30.7 MB / 请求
                                                   （历史里有 37 张截图）
改之后   ████                                       3.1 MB / 请求
                                                   （只有当前轮的图）
```

## 安装

```bash
pi install npm:pi-image-slim
```

或者不改动配置，直接试用一次：

```bash
pi -e npm:pi-image-slim
```

## 适合谁

- 你会把截图、设计稿、参考图或浏览器截图读进 Pi
- 你在慢速、计费或走代理的网络上工作
- 你发现请求要几十秒，而模型看起来一直闲着
- 你在聊天时从网络监控里看到很大的上行流量

如果你只是偶尔粘一张图、再也不回头看，那你不需要这个扩展。

## 它怎么工作

两个扩展钩子：

**1. `tool_result`** —— 给图片结果追加一行文件路径：

```
Read image file [image/png]
Image file: /Users/you/project/docs/mockups/title.png
```

这行文本会永远留在历史里。正是它让模型在图片像素不再被发送之后，仍然能重新找到那张图。

**2. `before_provider_request`** —— 在请求真正上链路之前，对最终序列化好的请求体做一次处理。所有不属于当前轮的图片都会被替换成：

```
[image removed from history to save upload bandwidth: /Users/you/project/docs/mockups/title.png — re-read that file if you need to see it again]
```

其它什么都不动。会话文件、`models.json`，以及磁盘上的原始图片全都保持原样。

### 按轮划分，而不是按数量

边界是**最后一条真实的用户消息**，不是"最后 N 张图"。

- 在同一轮里读十张图 → **十张都会完整发送。** 模型可以对比它们。
- 你说下一句话 → 上一轮的图变成占位符。
- 模型想再看 → 它会对那个路径调用 `read`，那张图会被重新上传一次。

这一点很关键：按数量截断的规则会在产出图片的那一轮里就悄悄丢图。像"保留最后 2 张图"这种规则，会把你这轮刚读的 10 张里只发 2 张。

### 模型每一轮看到什么

|                        | 发送内容         |
| ---------------------- | ---------------- |
| 当前轮读入的图片       | 完整图片数据     |
| 你刚粘贴或拖入的图片   | 完整图片数据     |
| 更早轮次的图片         | 带文件路径的占位符 |
| 其它一切               | 不变             |

## 实测

真实会话，通过 `read` 读了 37 张截图，历史里约 30.7 MB 的 base64：

|                | 请求体  | 500 KB/s 下的上传耗时 |
| -------------- | ------- | --------------------- |
| 不装扩展       | 30.7 MB | ~61 s                 |
| 装 `pi-image-slim` | 3.1 MB  | ~6 s                  |

处理本身的开销：30 MB 的请求体 **不到 1 ms**。它只是纯对象指针替换——不解码、不缩放、不重新编码，所以没有画质损失，也没有 CPU 抖动。

## 兼容性

占位符的形状依据模型的 API 选择，所以切换 provider 不会产生 HTTP 400：

| API | 占位符形状 |
| --- | --- |
| `openai-completions`、`anthropic-messages`、`mistral-conversations`、`pi-messages` | `{ type: "text", text }` |
| `openai-responses`、`azure-openai-responses`、`openai-codex-responses` | `{ type: "input_text", text }` |
| `google-generative-ai`、`google-vertex`、`bedrock-converse-stream` | `{ text }` |

以上所有协议里的图片块都能被识别，包括嵌套在 `tool_result` 内容里的图片。

## 注意事项

- **Prompt cache 会失效一部分。** 新的一轮开始时，请求体里有一个位置发生了变化，服务端缓存从那里往后失效。这个位置在当前轮的起点，也就是靠近请求体末尾，所以损失不大。
- **模型可能没注意到。** 如果模型凭记忆回答而不是重新读一遍占位符，它的答案是建立在"记得的图"而不是真实像素上的。做像素级的工作时，直接让它再看一次——它会去 `read` 那个文件。
- **轮次边界的判断依赖 Pi 的序列化细节**（`Attached image(s) from tool result:` 这条合成载体消息）。如果未来的 Pi 版本改变了这个形状，扩展会安全降级：找不到边界，就什么都不剥离。
- **磁盘占用不变。** 会话文件里依然保存着每一张图。这里减少的只是线上传输的部分。

## 关闭

```bash
PI_IMAGE_SLIM=off pi
```

或者直接卸载这个包。任何地方都没有持久化状态，所以移除后不留痕迹。

## 开发

```bash
git clone https://github.com/wiidede/pi-image-slim
cd pi-image-slim
pnpm install
pnpm test        # 18 个测试，不联网，不依赖磁盘文件
pnpm check       # lint + typecheck + 测试
```

测试覆盖了轮次划分、各协议的占位符形状、五种协议布局下的图片识别、幂等性、畸形请求体，以及一次带宽对比。

## License

[MIT](./LICENSE)
