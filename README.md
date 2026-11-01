# @kmchai/cortico-world-voice

Cortico 的语音 World：把回复念出来。协议无关、触发可控、播放可拆。

- **多种 TTS 协议**：audiocpp、OpenAI 兼容 `/v1/audio/speech`、自定义 JSON 模板。
- **三条触发路径**：工具显式调用、用户语义请求（「念给我听」）、按概率自动朗读。
- **情绪与标签**：自然语言指令、分类情绪、语速分档、副语言标签（`[Laughter]`、`[Sigh]` 等）。
- **文本过滤**：Markdown、代码、网址、动作标记、emoji、指定符号都不念。
- **出口可拆**：本机播放、发 `tts.voice` 事件交给播放插件、或只合成并交回音频附件。
- **本地语音接口**：QQ 插件、脚本、唱歌插件都能用同一个声音。
- **唱歌联动**：`voice_sing` 与 `【唱】` 前缀走唱歌插件的 HTTP 接口。

它不发送聊天消息，也不碰渠道。可见的回复仍走原来的发送工具；Voice 只负责声音。

## 安装

```bash
# 在部署的 extensions/ 目录里
corepack pnpm add "D:/path/to/cortico-world-voice" --ignore-workspace
```

或在控制台「扩展」页选「从本机目录安装」,装完重启进程。启用 `worlds.voice.enabled`。

## 最小配置

接本机 audiocpp（`ming3-tts`）：

```jsonc
{
  "worlds": {
    "voice": {
      "enabled": true,
      "backend": "audiocpp",
      "baseUrl": "http://127.0.0.1:8000",
      "model": "ming3-tts",
      "voice": "4016",
      "playback": "local",
      "autoSpeak": true,
      "autoProbability": 0.3
    }
  }
}
```

音频服务本身可以由 `@kmchai/cortico-world-audiocpp` 托管；也可以连任何已经在跑的服务。

## 触发

| 路径 | 行为 |
|---|---|
| `voice_speak` 工具 | 立即念；不受概率限制。可带 `emotion`、`instruct`、`voice`、`speed`、`silent`。 |
| 用户语义请求 | 最近 `explicitWindowSec` 秒内的外部消息含 `explicitKeywords`（默认「语音,声音,发语音,念给我听,读给我听,voice,tts」）时必定朗读。 |
| 自动朗读 | 助手正文、指定工具参数、指定事件三类来源，按 `autoProbability` 掷一次。 |
| `<tts>…</tts>` | 只念标签内文，并强制朗读。标签会出现在可见文字里；渠道可见时优先用工具触发。 |

自动来源：

- `autoFromText`：一轮里只有正文、没有函数调用时，念这一轮的正文。
- `autoTools`：这些工具的参数会被当作正文。默认 `pet_say, pet_ask, console_send`，取 `script` / `question` / `text` / `content` / `message` / `body` 里第一个字符串。
- `autoEvents`：轮询事件库，念这些事件类型的 `meta.body` 或正文。

同一段文字 5 秒内只念一次。概率按「一段话」掷，不按句掷。

只想响应工具与显式请求、不要随机朗读：保留 `autoSpeak: true`，把 `autoProbability` 设为 `0`。把 `autoSpeak` 整个关掉会让 tap 不再挂载，显式关键词也就看不到正文了；这时只保留 `voice_speak` 工具触发。

自动朗读依赖 Persona 把已挂载 World 的 `outputTap()` 扇进主 session；仓内 `cormini` 与 Coopanion 都这样做。只想要工具触发时，把 `autoSpeak` 关掉即可。

## 情绪、语速与标签

`emotionMode` 决定怎么发给后端：

| 值 | audiocpp | OpenAI 兼容 |
|---|---|---|
| `instruct`（默认） | `{template_name:"freeform", instruct:"…"}` | `instructions:"…"` |
| `categorical` | `{template_name:"emotion", emotion:"害羞"}` | 折进 `instructions` |
| `basic` | `{template_name:"basic", speed:"快速", pitch:"中", volume:"中"}` | 折进 `instructions` |
| `tags` | 不发情绪参数，只用正文标签 | 同左 |
| `none` | 都不发 | 都不发 |

- 情绪来源：工具参数 > 正文里的 `[emotion:开心]` 标记 > `defaultEmotion`。
- `voice_style` 读写长期风格（情绪、指令、音色、语速），写回 `worlds.voice`。
- 副语言标签：`[Breathing] [Cough] [Sigh] [Laughter] [Surprise-ah] [Surprise-oh] [Dissatisfaction-hnn] [Uhm] [Confirmation-en] [Question-ei] [Question-ah] [Question-en] [Question-oh] [Question-huh]`。
  `paralinguistic: auto` 只在 audiocpp 上保留，`keep` 一律保留，`strip` 一律删除。表外 `[...]` 会从朗读文本里剥掉，防止被念出来。

## 文本过滤

按顺序：取 `<tts>` 内文 → 去围栏代码/行内代码 → 去图片/链接/网址 → 去 Markdown 记号 → 去 `【…】`、`<…>`、`〈…〉` → 去 emoji 与不可见字符 → 去 `filterSymbols` 里的字符 → 压缩空白。

过滤后短于 `minChars` 不念，长于 `maxChars` 在句末截断。切句优先中英文句末标点，过长在逗号处再切；`chunkMax` 是单块上限，`gapMs` 是块间停顿。

## 出口

| `playback` | 行为 |
|---|---|
| `local`（默认） | 本机播放。Windows 用一个常驻 PowerShell 调 winmm MCI；macOS 用 `afplay`；Linux 用 `ffplay`/`paplay`/`aplay`。不需要原生 npm 模块。 |
| `event` | 每块推一条 `tts.voice` 事件（带音频附件，`deliver: false`）。`cortico-world-audio-play` 默认就监听这个类型。 |
| `none` | 只合成，不播放；适合语音只交给别的渠道。 |

`shareAudio: true` 时工具回执带音频附件，渠道工具可以用 `[blob …]` 句柄发送同一段音频。`silent: true` 的 `voice_speak` 只合成、不播放，并默认带回附件。

## 本地 HTTP 接口

`httpApi: true` 后只监听 `127.0.0.1:<httpPort>`（默认 9883），可配 `httpToken`：

| 路由 | 说明 |
|---|---|
| `GET /health` | `{ready, state, backend, model, voice, queue, sing}` |
| `GET /v1/models` | OpenAI 形状的模型列表 |
| `GET /v1/audio/voices` | 当前后端能列出的音色 |
| `POST /v1/audio/speech` | 体 `{input, voice?, emotion?, instructions?, speed?, response_format?, play?}`，回音频字节 |
| `POST /v1/audio/sing` | 体 `{lyrics}`，转给唱歌插件；没配置时 503 |

`httpPlay: true` 时经接口合成也在本机播放。接口默认不播，交给调用方处理。

## 唱歌

`singUrl` 指向唱歌插件的根地址（现有 DiffSinger 插件默认 `http://127.0.0.1:9882`），`POST /sing {lyrics}` 回 `audio/wav`。

- 工具：`voice_sing(lyrics)`。
- 自动来源里以 `【唱】`、`[唱]`、`[sing]` 开头的正文也会转给唱歌插件；没配置时按普通文本处理，不会静默改念。
- 唱歌插件可以是任何实现这个 HTTP 形状的包，Voice 不 import 它。

## 新协议

`src/backends/types.ts` 的 `TtsBackend` 只有三个方法：`synthesize`、`listVoices`、`health`。新增一种方言：

1. 在 `src/backends/` 新建一个文件，实现 `TtsBackend`；
2. 在 `src/backends/index.ts` 的 `BACKENDS` 里登记；
3. 在 `src/types.ts` 的 `BackendId` 与 `src/config.ts` 的 `backend` 枚举里加 id。

触发层、过滤层、队列与播放层都不需要改。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm smoke:audiocpp http://127.0.0.1:8000 out.wav   # 真服务,需要先启动 audiocpp
pnpm smoke:player out.wav                            # 本机播放器,音量 0
pnpm smoke:chain http://127.0.0.1:8000               # 触发→过滤→合成→tts.voice 全链路
```

装进 Cortico 后应看到：World 页多一张「语音」卡；启用后「语音服务」灯亮；让 bot 调 `voice_speak` 能听见；说「念给我听」会绕过概率；`playback: event` 时时间线出现 `tts.voice`。

## 许可

MIT。
