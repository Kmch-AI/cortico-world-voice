# @kmchai/cortico-world-voice

Kmch AI · 语音：把文字念出来的 World。只提供语音工具与音频出口；是否发语音由 bot 决定。合成交给 [Kmch AI · 服务](https://github.com/Kmch-AI/cortico-world-service)。

- **语音工具**：`voice_speak`、`voice_hush`。
- **没有触发层**：不监听主模型输出、不匹配关键词、不认 `<tts>`；只有调用 `voice_speak` 才会出声。
- **情绪与标签**：模型页选情绪控制方式与副语言标签策略，模型提示词随之改变，让模型只填当前会发送的字段。
- **文本过滤**：Markdown、代码、网址、动作标记、emoji、指定符号都不念。
- **出口可拆**：本机播放、发 `tts.voice` 事件交给播放插件、或只合成并交回音频附件。

它不发送聊天消息，也不碰渠道；可见的回复仍走原来的发送工具。Voice 只负责声音，不唱歌。

## 安装

装两个包：服务负责托管本机 TTS 并暴露网关，语音只连它。

```bash
# 在部署的 extensions/ 目录里
corepack pnpm add "D:/path/to/cortico-world-service" --ignore-workspace
corepack pnpm add "D:/path/to/cortico-world-voice" --ignore-workspace
```

或在控制台「扩展」页选「从本机目录安装」，装完重启进程。启用 `worlds.service.enabled` 与 `worlds.voice.enabled`。

## 最小配置

服务负责拉起本机 TTS 并暴露网关；语音只连它：

```jsonc
{
  "worlds": {
    "voice": {
      "enabled": true,
      "serviceUrl": "http://127.0.0.1:9883",
      "serviceTokenSecret": "",
      "model": "ming3-tts",
      "playback": "local"
    }
  }
}
```

`serviceUrl` 默认为 `http://127.0.0.1:9883`。`serviceTokenSecret` 填部署 `.env` 里的变量名，值只在请求时读取；服务监听非回环地址时必须配令牌。后端条目、模型 profile 与上游密钥都配在服务 World 里，见[服务包 README](https://github.com/Kmch-AI/cortico-world-service#readme)。

## 模型面板

World 页的「模型」tab 选模型与音色，并按服务 `/v1/models` 返回的参数元数据渲染字段。同一页的「声音与情绪」按模型保存情绪控制方式、默认情绪、默认表演指令、语速与副语言标签策略；切换模型时读回该模型自己的设置。模型设置存 `worlds.voice.modelStyles[model]`，模型参数存 `worlds.voice.modelOptions[model]`；合成时作为 `options` 发给服务。

「模型提示词」折叠区显示当前模型 + 当前设置下模型该怎么填 `voice_speak`；切换情绪控制方式或副语言标签策略时立即重算。同一份片段经 `{{voice.modelPrompt}}` 进入环境提示词，所以面板上看到的就是模型拿到的。预览立即更新；环境提示词在会话前缀重建或新会话时进入模型上下文。未知模型按 OpenAI 兼容处理：只保证 `instruct` 与 `speed`，不提供「情绪标签」方式，合成也不发 `emotion`。

## 工具

| 工具 | 作用 |
|---|---|
| `voice_speak` | 念一句；可带 `emotion`、`instruct`、`voice`、`speed`、`silent`。只填提示词允许的字段。 |
| `voice_hush` | 立刻停声，清空排队。 |

`silent: true` 只合成、不在本机播放，音频随工具回执交给渠道，用于语音条这类出口。

## 何时发语音

语音 World 不做触发判定。bot / Persona 决定这一轮要不要出声，需要出声时调用 `voice_speak`；本机播放由 `playback` 决定，交给其他渠道时带 `silent: true`。对方让停下时调用 `voice_hush`。

旧版的 `explicitTrigger`、`explicitKeywords`、`explicitWindowSec` 与正文里的 `<tts>…</tts>` 都已删除；是否发语音不再看用户消息关键词或助手正文。

## 情绪、语速与标签

情绪与语速设置按模型保存在「模型」页。语音只把语义字段发给服务，由服务的模型 profile 决定怎么落到具体模型；模型提示词与发送逻辑用同一份设置：

| `emotionMode` | 语音发送 | 提示词要求模型填 | `audiocpp-ming3` profile 的落点 |
|---|---|---|---|
| `instruct`（默认） | `instructions`：默认情绪/指令与语速折成自然语言。 | `instruct`；`speed` 可选。 | `options.template_name = "freeform"`，带上指令。 |
| `categorical` | `emotion`：只发情绪标签；没配时用「平静」。 | `emotion`。 | `emotion` 字段；未知的 OpenAI 兼容模型没有这个字段，面板不提供该方式，旧配置会提示按默认语气朗读。 |
| `basic` | `speed`：只发语速倍率。 | `speed`。 | `basic` 模板，按 `speedLevels` 取慢速/中速/快速；IndexTTS2 的独立语速不落到模型，面板不提供这一项。 |
| `tags` | 不发情绪参数，只用正文标签。 | 正文里的副语言标签。 | 正文标签。 |
| `none` | 都不发。 | 不填情绪字段。 | — |

OpenAI 兼容条目把 `instructions` / `emotion` / `speed` 直接放进请求。IndexTTS2 把 `instructions` 或 `emotion` 映射成 `use_emotion_text: true` 与 `emotion_text`；`speed` 只作为文字并入指令。其他模型可在服务面板里覆盖 profile 的字段映射，语音不用改配置。

`response_format` 每次都带；`model` 与 `voice` 配了才带，工具参数里的音色优先于配置默认值。

- 情绪来源：工具参数 > 正文里的 `[emotion:开心]` 标记 > 当前模型的 `defaultEmotion`。
- 副语言标签：`[Breathing] [Cough] [Sigh] [Laughter] [Surprise-ah] [Surprise-oh] [Dissatisfaction-hnn] [Uhm] [Confirmation-en] [Question-ei] [Question-ah] [Question-en] [Question-oh] [Question-huh]`。
  `paralinguistic: auto` 只在当前模型支持标签（Ming 3.0 系）时保留，IndexTTS2 与通用模型剥掉；`keep` 一律保留，`strip` 一律删除。表外 `[...]` 会从朗读文本里剥掉，防止被念出来。
  选择 `strip` 时，提示词会明确禁止模型写方括号标签；模型支持标签时，提示词会列出可用标签并允许内联；`keep` 强制保留但模型不支持时，提示词会警告标签可能被念出字面。

## 文本过滤

按顺序：去围栏代码/行内代码 → 去图片/链接/网址 → 去 Markdown 记号 → 去 `【…】`、`<…>`、`〈…〉` → 规范或删除副语言标签 → 去 emoji 与不可见字符 → 去 `filterSymbols` 里的字符 → 压缩空白。

过滤后短于 `minChars` 不念，长于 `maxChars` 在句末截断。切句优先中英文句末标点，过长在逗号处再切；`chunkMax` 是单块上限，`gapMs` 是块间停顿。

## 出口

| `playback` | 行为 |
|---|---|
| `local`（默认） | 本机播放。Windows 用一个常驻 PowerShell 调 winmm MCI；macOS 用 `afplay`；Linux 用 `ffplay`/`paplay`/`aplay`。不需要原生 npm 模块。 |
| `event` | 每块推一条 `tts.voice` 事件（带音频附件，`deliver: false`）。`cortico-world-audio-play` 默认就监听这个类型。 |
| `none` | 只合成，不播放；适合语音只交给别的渠道。 |

`shareAudio: true` 时工具回执带音频附件，渠道工具可以用 `[blob …]` 句柄发送同一段音频。`silent: true` 的 `voice_speak` 只合成、不播放，并默认带回附件。

## 与服务的关系

语音只经 HTTP 调服务，不解析后端方言、不监听端口、不做模型 profile：

| 路由 | 用途 |
|---|---|
| `POST /v1/audio/speech` | 合成音频；体 `{model?, input, voice?, response_format, speed?, instructions?, emotion?}`。 |
| `GET /health` | 探活；World 页的服务灯每 15 秒刷新。 |
| `GET /v1/models` | 模型、音色与请求参数元数据。 |
| `GET /v1/audio/voices?model=` | 当前模型的音色表。 |

服务不可达时：模型与音色下拉保留上一次读到的表，服务灯变红，`voice_speak` 回失败。语音不保留直连后端的回退路径。服务不重试上游，语音也不重试。

## 从 0.4.x 迁移

| 0.4.x | 0.5.0 |
|---|---|
| `voice_style` 工具 | 删除；长期风格只在「模型」页设置。 |
| `explicitTrigger` / `explicitKeywords` / `explicitWindowSec` | 删除，配置里残留也会被忽略；是否发语音由 bot 决定。 |
| 正文 `<tts>…</tts>` | 不再识别；要念的内容放进 `voice_speak` 的 `text`。 |
| 普通回复 | 从来不会自动朗读；现在语音完全不看主模型输出。 |

## 从 0.3.x 迁移

| 0.3.x | 0.4.0 |
|---|---|
| `autoSpeak` / `autoProbability` / `autoFromText` / `autoTools` / `autoEvents` | 删除，配置里残留也会被忽略。 |
| 自动朗读 | 改用 `voice_speak`。 |

## 从 0.1.x 迁移

| 0.1.x | 0.2.0 |
|---|---|
| `backend`、`baseUrl`、`apiKeySecret` | 删除；在服务里添加对应服务条目，语音改填 `serviceUrl` 与 `serviceTokenSecret`。 |
| `customUrl` / `customMethod` / `customHeaders` / `customBody` / `customResponse` / `customAudioPath` | 删除；在服务的 `custom` 条目里配置。 |
| `httpApi` / `httpPort` / `httpToken` / `httpPlay` | 删除；服务的网关取代本地语音接口。 |
| `singUrl` / `singToken`、`voice_sing`、`【唱】` | 删除；唱歌由服务的 `/v1/audio/sing` 与网关接入。 |
| `model` / `voice` / `format` / `timeoutMs` | 保留，含义不变。 |
| `emotionMode` / `defaultEmotion` / `defaultInstruct` / `speed` / `paralinguistic` | 移到「模型」页，按模型保存；旧全局值仍作为没有模型设置时的回落。 |
| 触发、过滤、输出配置 | 保留（触发配置已在 0.5.0 删除）。 |

## 验证

```bash
pnpm typecheck
pnpm test
pnpm smoke:player out.wav                 # 本机播放器,音量 0
```

装进 Cortico 后应看到：World 页多一张「Kmch AI · 语音」卡，服务灯、队列灯与 `service` / `model` / `voice` 徽标；「模型」tab 能选模型与音色，按模型调整声音与情绪，切换情绪控制方式时「模型提示词」立即变化；服务在线时灯亮；bot 调 `voice_speak` 能听见；普通回复不会自己出声；`playback: event` 时时间线出现 `tts.voice`。

## 许可

MIT。
