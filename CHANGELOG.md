## 0.1.0

- 初版:协议无关的 TTS World,内置 audiocpp / OpenAI 兼容 / custom JSON 三种适配器。
- 触发:工具、显式关键词、`<tts>` 标记、助手正文、工具参数、事件轮询;自动朗读按概率。
- 情绪与标签:instruct / categorical / basic / tags / none 五种模式;副语言标签按后端保留或删除。
- 文本过滤与切句;本机播放、事件出口、tool 附件三种输出;本地语音 HTTP 接口;唱歌插件 HTTP 联动。
