/** 工具声明(不含 handler);`describe.tools` 与 `tools()` 都从这里取。 */
import type { ToolSpec } from 'cortico/core/types.ts';

export const VOICE_TOOL_DECLS: readonly ToolSpec[] = [
  {
    name: 'voice_speak',
    description:
      'Say a line aloud in your voice through the person\'s speakers, or only synthesize it when silent is true. '
      + 'Nothing is spoken automatically: this tool is the only way to make sound. Use it when you decide a reply should be spoken, or when the person asks for voice. '
      + 'Fill only the fields allowed by the current model guidance in the environment prompt. '
      + 'It only makes sound; the visible reply still goes through the channel\'s own send tool. '
      + 'When the current settings allow paralinguistic tags, keep them inline in the text: [Laughter], [Sigh], [Breathing], [Uhm], [Question-ei] and the like are performed, not read out.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: 2000, description: 'The line to say.' },
        emotion: { type: 'string', maxLength: 40, description: 'Emotion for this line when the current emotion control sends emotion, for example 开心、温柔、疲惫. Omit to use the standing emotion.' },
        instruct: { type: 'string', maxLength: 500, description: 'Natural-language direction for this line when the current emotion control sends instruct, for example "像在耳边轻声说话，语速偏慢". Omit to use the standing direction.' },
        voice: { type: 'string', maxLength: 200, description: 'Voice id for this line. Omit to use the configured voice.' },
        speed: { type: 'number', minimum: 0.5, maximum: 2, description: 'Speed multiplier for this line; 1 is normal. Only used when the current emotion control sends speed or folds it into instruct.' },
        silent: { type: 'boolean', description: 'true synthesizes without playing on this computer; use it for a line meant for another channel.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'voice_hush',
    description: 'Stop the voice now: the line playing is cut and queued lines are dropped. It does not affect the visible reply.',
    tags: ['speak'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];
