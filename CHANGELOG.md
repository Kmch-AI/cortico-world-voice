## 0.3.0

- 系统 Config tab 移除「音色与情绪」组;音色、情绪控制、默认情绪、默认表演指令、语速与副语言标签移到「模型」页。
- 朗读风格按模型保存进 `worlds.voice.modelStyles[model]`;切换模型时面板读回该模型的音色、风格与参数,不用先保存。旧全局字段保留为没有模型设置时的回落。
- `voice_style` 在选定模型后只写当前模型的风格;没有模型时仍写全局回落值。
- 服务返回的 Ming 3.0 模型参数(模板、语言、指令语言、音高、音量、生成与分块参数)在模型页显示;IndexTTS2 的中文参数名继续保留。
- 文本过滤、合成与 `tts.voice` 事件都使用当前模型生效的风格。

## 0.2.1

- 新增 World 页的「模型」面板:模型与音色在面板里选,不再占系统 Config tab 的字段。
- 按服务 `/v1/models` 返回的参数元数据渲染字段:开关、枚举、数字与文本;IndexTTS2 的参数带中文名。
- 模型专属参数存进 `worlds.voice.modelOptions[model]`,请求时作为 `options` 发给服务;空对象删掉该模型的条目。
- 面板显示当前模型的提示词片段;目录缓存在进程内,服务不可达时保留上一次结果并报错。
- 新增 `scripts/build-webui.mjs`(esbuild)与 `dist/webui.js` / `dist/webui.css`。

## 0.2.0

分层:协议、进程托管与 HTTP 网关移到 `@kmchai/cortico-world-service`;语音只保留工具、概率朗读、文本过滤、情绪与标签语义、队列和本机播放,经 HTTP 调服务。

### 破坏性变更

- 语音不再直连 TTS 后端,也不再监听本地 HTTP。合成统一走服务的 `/v1/audio/speech`,探活与目录用 `/health`、`/v1/models`、`/v1/audio/voices`;服务不可达时没有回退路径。
- 新配置 `serviceUrl`(默认 `http://127.0.0.1:9883`)与 `serviceTokenSecret`;删除 `backend`、`baseUrl`、`apiKeySecret`、`custom*`、`http*`、`sing*`。这些后端配置改到服务 World 里。
- 删除 `src/backends/`、`src/http.ts`、`src/sing.ts`;新增 `src/service.ts` 客户端。
- 删除 `voice_sing` 工具、`【唱】` 前缀与全部唱歌配置;语音不唱歌,唱歌改由服务的 `/v1/audio/sing` 与网关接入。工具只剩 `voice_speak` / `voice_hush` / `voice_style`。
- 情绪模式只决定发哪个语义字段:instruct 发 `instructions`,categorical 发 `emotion`,basic 发 `speed`,tags/none 不发;怎么落到具体模型由服务的模型 profile 决定。
- 副语言标签 `auto` 一律保留,由服务里的模型决定演不演;保留 `keep` / `strip`。

### 界面与目录

- World 页改为服务灯与队列灯;徽标显示服务地址主机、模型与音色;音色与模型下拉从服务目录刷新,读不到时保留上次结果。
- World 页链到服务 World 的配置页。
- 环境提示词重写:只说明声音能力、工具与文本规则,不提后端、协议或 HTTP。

## 0.1.1

- 市场元数据:补中文关键词与 `cortico.locales`,中文界面显示「语音」而不是包名。

## 0.1.0

- 初版:协议无关的 TTS World,内置 audiocpp / OpenAI 兼容 / custom JSON 三种适配器。
- 触发:工具、显式关键词、`<tts>` 标记、助手正文、工具参数、事件轮询;自动朗读按概率。
- 情绪与标签:instruct / categorical / basic / tags / none 五种模式;副语言标签按后端保留或删除。
- 文本过滤与切句;本机播放、事件出口、tool 附件三种输出;本地语音 HTTP 接口;唱歌插件 HTTP 联动。
