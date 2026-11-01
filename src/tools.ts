/** 工具声明(不含 handler);`describe.tools` 与 `tools()` 都从这里取。 */
import type { ToolSpec } from 'cortico/core/types.ts';

export const VOICE_TOOL_DECLS: readonly ToolSpec[] = [
  {
    name: 'voice_speak',
    description:
      'Say a line aloud in your voice through the person\'s speakers, or only synthesize it when silent is true. '
      + 'Use it when the person asks for voice, when this line needs a specific emotion or voice, or when automatic reading is off. '
      + 'It only makes sound; the visible reply still goes through the channel\'s own send tool. '
      + 'When the backend supports paralinguistic tags, keep them inline in the text: [Laughter], [Sigh], [Breathing], [Uhm], [Question-ei] and the like are performed, not read out.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', maxLength: 2000, description: 'The line to say.' },
        emotion: { type: 'string', maxLength: 40, description: 'Emotion for this line, for example 开心、温柔、疲惫. Omit to use the standing style.' },
        instruct: { type: 'string', maxLength: 500, description: 'Natural-language direction for this line, for example "像在耳边轻声说话，语速偏慢". Omit to use the standing style.' },
        voice: { type: 'string', maxLength: 200, description: 'Voice id for this line. Omit to use the configured voice.' },
        speed: { type: 'number', minimum: 0.5, maximum: 2, description: 'Speed multiplier for this line; 1 is normal.' },
        silent: { type: 'boolean', description: 'true synthesizes without playing on this computer; use it for a line meant for another channel.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'voice_sing',
    description:
      'Sing a lyric line through the configured singing plugin. It only makes sound; the visible reply still goes through the channel\'s own send tool. '
      + 'If no singing plugin is configured, or it is not ready, the call fails instead of speaking the lyrics.',
    tags: ['speak'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lyrics: { type: 'string', maxLength: 2000, description: 'The lyric line to sing.' },
      },
      required: ['lyrics'],
    },
  },
  {
    name: 'voice_hush',
    description: 'Stop the voice now: the line playing is cut and queued lines are dropped. It does not affect the visible reply.',
    tags: ['speak'],
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'voice_style',
    description:
      'Read or change the standing voice style used by automatic reading. Call with values to change them; call with no arguments to read the current style. '
      + 'Changes are saved to the World configuration and apply to later lines.',
    tags: ['write'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        emotion: { type: 'string', maxLength: 40, description: 'Standing emotion; an empty string clears it.' },
        instruct: { type: 'string', maxLength: 500, description: 'Standing natural-language direction; an empty string clears it.' },
        voice: { type: 'string', maxLength: 200, description: 'Standing voice id.' },
        speed: { type: 'number', minimum: 0.5, maximum: 2, description: 'Standing speed multiplier.' },
      },
    },
  },
];
