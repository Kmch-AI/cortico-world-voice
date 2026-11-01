import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { VOICE_DEFAULTS, VOICE_ID, VOICE_LABEL } from './config.ts';
import { VOICE_TOOL_DECLS } from './tools.ts';
import type { VoiceConfigSection } from './types.ts';
import { VoiceWorld } from './world.ts';

export const VOICE: WorldDefinition<VoiceConfigSection> = {
  id: VOICE_ID,
  label: VOICE_LABEL,
  defaults: () => ({ ...VOICE_DEFAULTS, modelOptions: {} }),
  create: (ctx) => new VoiceWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    secret: (name) => ctx.secret(name),
    persist: (patch) => ctx.persist(patch),
  }),
  describe: {
    tools: describeTools(VOICE_TOOL_DECLS, {
      voice_speak: { zh: '现在念一句;可指定情绪、表演指令、音色与语速,也可以只合成不出声。', en: 'Say one line now, optionally with an emotion, direction, voice and speed, or synthesize it silently.' },
      voice_hush: { zh: '立刻停声并清空排队。', en: 'Stop the voice and drop queued lines.' },
      voice_style: { zh: '读或改自动朗读使用的长期音色与情绪。', en: 'Read or change the standing voice style used by automatic reading.' },
    }),
    events: [
      {
        type: 'tts.voice',
        description: { zh: '一段语音合成完成,带音频附件;只归档,供播放类插件取用。', en: 'One spoken chunk finished, with its audio attachment; archived only for playback plugins.' },
      },
      {
        type: 'voice.failed',
        description: { zh: '合成或播放失败;只归档,供排查。', en: 'Synthesis or playback failed; archived only for diagnosis.' },
      },
    ],
  },
};
