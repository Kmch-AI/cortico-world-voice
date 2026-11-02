/**
 * 语音 World:把回复念出来。
 *
 * 触发层从主 session 输出流与事件库认出要念的话;文本层过滤与切句;
 * 合成层经 HTTP 调 Kmch AI · 服务;出口层本机播放、发事件或只返回附件。
 * 这一层不解析任何 TTS 方言,也不监听端口。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Language } from 'cortico/core/language.ts';
import type {
  Logger, ToolDef, ToolOutcome, World, WorldHost, WorldLamp, WorldWebUiDecl,
} from 'cortico/core/types.ts';
import { nullLogger, nowIso } from 'cortico/core/util.ts';
import { modelStyle, styledConfig, VOICE_DEFAULTS, VOICE_ID, voiceConfigGroups, voiceText } from './config.ts';
import type { AudioPlayer } from './audio/player.ts';
import { createPlayer } from './audio/player.ts';
import { SpeechQueue, type SpeechJob } from './audio/queue.ts';
import { modelPrompt } from './models.ts';
import { isPlainObject, type PanelModelSetting, type PanelModelState } from './panel.ts';
import { ServiceClient, type SpeechService } from './service.ts';
import { splitSpeech, truncateSpeech } from './speech/chunk.ts';
import { buildInstruct, resolveStyle } from './speech/style.ts';
import { filterSpeech } from './speech/text.ts';
import { hasKeyword, latestUserText, VoiceTap } from './triggers.ts';
import { VOICE_TOOL_DECLS } from './tools.ts';
import type {
  EmotionMode, ParalinguisticMode, ServiceHealth, TtsAudio, TtsRequest, VoiceConfigSection,
  VoiceModel, VoiceModelStyle,
} from './types.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const DEDUPE_WINDOW_MS = 5000;
const HEALTH_INTERVAL_MS = 15_000;
const HEALTH_TTL_MS = 15_000;

export interface VoiceWorldDeps {
  fetch: typeof fetch;
  createPlayer(log: Logger): AudioPlayer | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** 测试用:替换服务客户端。 */
  service?: SpeechService;
}

export interface VoiceWorldOptions {
  /** `worlds.voice` 的活引用。 */
  cfg: VoiceConfigSection;
  timezone: string;
  dataDir: string;
  secret(name: string): string;
  persist(patch: Partial<VoiceConfigSection>): void;
  log?: Logger;
  deps?: Partial<VoiceWorldDeps>;
}

interface EnqueueOptions {
  source: string;
  emotion?: string;
  instruct?: string;
  voice?: string;
  speed?: number;
  silent?: boolean;
}

interface ServiceState {
  ok: boolean;
  detail?: string;
  at: number;
}

function defaultDeps(): VoiceWorldDeps {
  return {
    fetch: ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init)) as typeof fetch,
    createPlayer,
    now: () => Date.now(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** 徽标只显示主机与端口;地址不合法时退回原串。 */
function serviceHost(raw: string): string {
  const value = raw.trim();
  if (!value) return '—';
  try {
    return new URL(value).host || '—';
  } catch {
    return value;
  }
}

/** 等一个 promise;超时返回 'timeout',不取消原任务。 */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class VoiceWorld implements World {
  readonly id = VOICE_ID;
  private readonly log: Logger;
  private readonly deps: VoiceWorldDeps;
  private readonly player: AudioPlayer | null;
  private readonly queue: SpeechQueue;
  private readonly tap: VoiceTap;
  private readonly service: SpeechService;
  private host: WorldHost | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private started = false;
  private tempDir = '';
  private tempSeq = 0;
  private serviceState: ServiceState | null = null;
  private probing = false;
  private catalog: VoiceModel[] | null = null;
  private catalogError: string | undefined;
  private catalogLoad: Promise<void> | null = null;
  private readonly lastSpoken = new Map<string, number>();
  private lastFailureAt = 0;

  constructor(private readonly opts: VoiceWorldOptions) {
    this.log = opts.log ?? nullLogger();
    this.deps = { ...defaultDeps(), ...opts.deps };
    this.service = this.deps.service ?? new ServiceClient({
      fetch: this.deps.fetch,
      secret: (name) => this.opts.secret(name),
      cfg: () => this.styled,
    });
    this.player = this.deps.createPlayer(this.log);
    this.queue = new SpeechQueue({
      player: this.player,
      settings: () => ({ playback: this.cfg.playback, volume: this.cfg.volume, gapMs: this.cfg.gapMs }),
      log: this.log,
      sleep: this.deps.sleep,
      writeTemp: (bytes, mime) => this.writeTemp(bytes, mime),
      removeTemp: (path) => { try { rmSync(path, { force: true }); } catch { /* 临时文件,删不掉也无所谓 */ } },
      emit: (audio, job, chunk) => this.emitVoice(audio, job, chunk),
      onError: (job, message) => { void this.pushFailure(message, { source: job.source }); },
    });
    this.tap = new VoiceTap({
      onText: (text, source) => this.consider(text, source),
      onAbort: () => this.queue.hush(),
    });
  }

  private get cfg(): VoiceConfigSection {
    return this.opts.cfg;
  }

  /** 当前模型的配置视图:模型专属的朗读风格盖在全局值上。 */
  private get styled(): VoiceConfigSection {
    return styledConfig(this.cfg, this.cfg.model);
  }

  envPromptVars(): Record<string, string> {
    const cfg = this.styled;
    return {
      'voice.voice': cfg.voice || 'default',
      'voice.emotion': cfg.defaultEmotion || 'neutral',
      'voice.instruct': cfg.defaultInstruct || 'none',
      'voice.modelPrompt': modelPrompt(this.cfg.model),
    };
  }

  tools(): ToolDef[] {
    const byName = new Map(VOICE_TOOL_DECLS.map((d) => [d.name, d]));
    const tool = (name: string, handler: ToolDef['handler']): ToolDef => ({
      ...byName.get(name)!,
      handler,
    });
    return [
      tool('voice_speak', (args) => this.handleSpeak(args)),
      tool('voice_hush', async () => {
        this.queue.hush();
        return 'Voice stopped; queued lines were dropped.';
      }),
      tool('voice_style', (args) => this.handleStyle(args)),
    ];
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const t = voiceText(language);
    this.maybeRefresh();
    const cfg = this.styled;
    const stats = this.queue.stats();
    const serviceLamp: WorldLamp = this.serviceState === null
      ? { label: t.lampService, state: this.started ? 'loading' : 'offline' }
      : this.serviceState.ok
        ? { label: t.lampService, state: 'online', ...(this.serviceState.detail ? { hint: this.serviceState.detail } : {}) }
        : { label: t.lampService, state: 'error', ...(this.serviceState.detail ? { hint: this.serviceState.detail } : {}) };
    return {
      label: t.label,
      lamps: [
        serviceLamp,
        {
          label: t.lampQueue,
          state: !this.started ? 'offline' : stats.speaking ? 'loading' : 'online',
          hint: `${stats.queued}`,
        },
      ],
      badges: [
        { label: 'service', value: serviceHost(cfg.serviceUrl), tone: 'plain' },
        { label: 'model', value: cfg.model || '—', tone: 'plain' },
        { label: 'voice', value: cfg.voice || '—', tone: 'plain' },
      ],
      panels: [{ id: 'model', title: t.modelPanel, getMethods: ['state'] }],
      config: voiceConfigGroups(language),
      links: [{ label: t.servicePage, href: '#/provider/world:service' }],
      invoke: async (panel, method, args) => {
        if (panel !== 'model') throw new Error(t.modelUnknownMethod);
        switch (method) {
          case 'state':
            return this.modelPanelState();
          case 'refresh':
            return this.refreshModelPanel();
          case 'save':
            return this.saveModelPanel(language, args);
          default:
            throw new Error(t.modelUnknownMethod);
        }
      },
      promptDocs: [{
        key: 'worlds.voice.envPrompt',
        title: t.envTitle,
        description: '',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'voice.voice', description: 'Current voice id.' },
          { name: 'voice.emotion', description: 'Standing emotion.' },
          { name: 'voice.instruct', description: 'Standing direction.' },
          { name: 'voice.modelPrompt', description: 'How to write text and emotion for the current model.' },
        ],
      }],
    };
  }

  // ———————— 模型面板 ————————

  /**
   * 第一次读面板时拉一次目录;之后直接回缓存。刷新失败保留上一次可用的目录,
   * 只把错误一起交回面板。
   */
  private async modelPanelState(): Promise<PanelModelState> {
    if (!this.catalog) await this.loadCatalog(this.cfg.model);
    return this.panelSnapshot();
  }

  private async refreshModelPanel(): Promise<PanelModelState> {
    if (this.catalogLoad) await this.catalogLoad;
    await this.loadCatalog(this.cfg.model);
    return this.panelSnapshot();
  }

  private panelSnapshot(): PanelModelState {
    const cfg = this.cfg;
    const settings = this.panelSettings();
    const current = settings[cfg.model];
    const style = current?.style ?? modelStyle(cfg, cfg.model);
    return {
      model: cfg.model,
      voice: style.voice,
      prompt: modelPrompt(cfg.model),
      prompts: Object.fromEntries(Object.keys(settings).map((id) => [id, modelPrompt(id)])),
      options: current?.options ?? {},
      style,
      models: this.catalog ?? [],
      settings,
      ...(this.catalogError ? { error: this.catalogError } : {}),
    };
  }

  /** 目录里每个模型的音色、风格与参数;当前模型与已保存过设置的模型也各带一条。 */
  private panelSettings(): Record<string, PanelModelSetting> {
    const ids = new Set((this.catalog ?? []).map((model) => model.id));
    if (this.cfg.model.trim()) ids.add(this.cfg.model.trim());
    for (const id of Object.keys(this.cfg.modelStyles ?? {})) if (id.trim()) ids.add(id);
    for (const id of Object.keys(this.cfg.modelOptions ?? {})) if (id.trim()) ids.add(id);
    const out: Record<string, PanelModelSetting> = {};
    for (const id of ids) {
      const style = modelStyle(this.cfg, id);
      const saved = this.cfg.modelOptions?.[id];
      out[id] = {
        voice: style.voice,
        style,
        options: isPlainObject(saved) ? { ...saved } : {},
      };
    }
    return out;
  }

  private loadCatalog(selected: string): Promise<void> {
    if (this.catalogLoad) return this.catalogLoad;
    this.catalogLoad = this.fetchCatalog(selected).finally(() => {
      this.catalogLoad = null;
    });
    return this.catalogLoad;
  }

  /**
   * 先取模型表,再尽力为当前模型补一次更细的音色表。模型表是权威来源,已经带
   * 音色与参数;补音色失败只损失一次补全,不能让整份目录跟着作废。
   */
  private async fetchCatalog(selected: string): Promise<void> {
    let models: VoiceModel[];
    try {
      models = await this.service.models();
    } catch (error) {
      this.catalogError = this.catalogFailure(error);
      this.markService({ ok: false, detail: this.catalogError });
      return;
    }

    const id = selected.trim() || this.cfg.model.trim() || models[0]?.id || '';
    let catalog = models;
    if (id) {
      try {
        const voices = await this.service.voices(id);
        const names = [...new Set(voices.map((voice) => voice.value.trim()).filter(Boolean))];
        if (names.length > 0) {
          catalog = models.map((model) => (model.id === id ? { ...model, voices: names } : model));
        }
      } catch (error) {
        this.log.debug('音色表读取失败,保留模型表里的音色', {
          err: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.catalog = catalog;
    this.catalogError = undefined;
    this.markService({ ok: true });
  }

  /** 错误要回面板,但不能把配置里的服务地址(可能带令牌)一起带出去。 */
  private catalogFailure(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const url = this.cfg.serviceUrl.trim();
    return url && message.includes(url) ? message.split(url).join('[service]') : message;
  }

  private saveModelPanel(language: Language, args: unknown[]): PanelModelState {
    const t = voiceText(language);
    const raw = args[0];
    if (!isPlainObject(raw)) throw new Error(t.modelSaveShape);
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!model) throw new Error(t.modelSaveModel);
    if (typeof raw.voice !== 'string') throw new Error(t.modelSaveVoice);
    if (raw.style !== undefined && !isPlainObject(raw.style)) throw new Error(t.modelSaveStyle);
    if (!isPlainObject(raw.options)) throw new Error(t.modelSaveOptions);

    const style = this.readModelStyle(raw.style, model, raw.voice.trim(), t.modelSaveStyle);
    const nextStyles: VoiceConfigSection['modelStyles'] = { ...(this.cfg.modelStyles ?? {}) };
    nextStyles[model] = style;

    const nextOptions: VoiceConfigSection['modelOptions'] = { ...(this.cfg.modelOptions ?? {}) };
    // 空对象表示删掉这个模型的条目,回到服务的默认参数。
    if (Object.keys(raw.options).length === 0) delete nextOptions[model];
    else nextOptions[model] = { ...raw.options };
    // 配置层对对象做深合并,删掉的键不会随 patch 传播;先让活引用指向新对象再写盘。
    this.cfg.modelStyles = nextStyles;
    this.cfg.modelOptions = nextOptions;
    this.opts.persist({ model, modelStyles: nextStyles, modelOptions: nextOptions });
    return this.panelSnapshot();
  }

  /** 面板传来的风格字段逐个校验;没给的字段沿用这个模型当前生效的值。 */
  private readModelStyle(
    raw: Record<string, unknown> | undefined,
    model: string,
    voice: string,
    shapeError: string,
  ): VoiceModelStyle {
    const current = modelStyle(this.cfg, model);
    if (!raw) return { ...current, voice };

    const emotionModes: readonly EmotionMode[] = ['instruct', 'categorical', 'basic', 'tags', 'none'];
    const paralinguisticModes: readonly ParalinguisticMode[] = ['auto', 'keep', 'strip'];
    const emotionMode = raw.emotionMode ?? current.emotionMode;
    if (typeof emotionMode !== 'string' || !emotionModes.includes(emotionMode as EmotionMode)) {
      throw new Error(shapeError);
    }
    const paralinguistic = raw.paralinguistic ?? current.paralinguistic;
    if (typeof paralinguistic !== 'string' || !paralinguisticModes.includes(paralinguistic as ParalinguisticMode)) {
      throw new Error(shapeError);
    }
    const defaultEmotion = raw.defaultEmotion ?? current.defaultEmotion;
    if (typeof defaultEmotion !== 'string') throw new Error(shapeError);
    const defaultInstruct = raw.defaultInstruct ?? current.defaultInstruct;
    if (typeof defaultInstruct !== 'string') throw new Error(shapeError);
    const rawSpeed = raw.speed ?? current.speed;
    if (typeof rawSpeed !== 'number' || !Number.isFinite(rawSpeed)) throw new Error(shapeError);
    return {
      voice,
      emotionMode: emotionMode as EmotionMode,
      defaultEmotion: defaultEmotion.trim().slice(0, 40),
      defaultInstruct: defaultInstruct.trim().slice(0, 500),
      speed: Math.min(2, Math.max(0.5, rawSpeed)),
      paralinguistic: paralinguistic as ParalinguisticMode,
    };
  }

  outputTap() {
    // 概率触发已删除;旁路只用于显式关键词与 <tts> 的判定。
    return this.tap;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.started = true;
    this.log.info('语音 World 启动', {
      service: serviceHost(this.cfg.serviceUrl),
      playback: this.cfg.playback,
      explicit: this.cfg.explicitTrigger,
    });
    if (this.cfg.playback === 'local') {
      void this.player?.warm(this.ensureTempDir()).catch((error: unknown) => {
        this.log.warn('播放器预热失败', { err: error instanceof Error ? error.message : String(error) });
      });
    }
    void this.probe();
    this.healthTimer = setInterval(() => { void this.probe(); }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    await this.queue.close();
    if (this.tempDir) {
      try { rmSync(this.tempDir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
      this.tempDir = '';
    }
    this.host = null;
    this.log.info('语音 World 停止');
  }

  // ———————— 触发 ————————

  /** 同一段文字在去重窗口内只处理一次。 */
  private fresh(text: string): boolean {
    const key = text.toLowerCase().replace(/\s+/g, '');
    const now = this.deps.now();
    for (const [seen, at] of this.lastSpoken) if (now - at > DEDUPE_WINDOW_MS) this.lastSpoken.delete(seen);
    if (this.lastSpoken.has(key)) return false;
    this.lastSpoken.set(key, now);
    return true;
  }

  private consider(raw: string, source: string): void {
    if (!this.started) return;
    const cfg = this.cfg;
    const filtered = filterSpeech(raw, this.styled);
    if (!filtered.text) return;

    const userText = cfg.explicitTrigger
      ? latestUserText(this.host!, cfg.explicitWindowSec, this.deps.now())
      : '';
    const explicit = filtered.forced || (cfg.explicitTrigger && hasKeyword(userText, cfg.explicitKeywords));
    if (!explicit) return;
    if (!this.fresh(filtered.text)) return;

    this.enqueue(filtered.text, {
      source,
      ...(filtered.emotion ? { emotion: filtered.emotion } : {}),
    });
    this.log.debug('显式朗读', { source, chars: [...filtered.text].length });
  }

  private enqueue(text: string, opts: EnqueueOptions): ReturnType<SpeechQueue['enqueue']> | null {
    const cfg = this.cfg;
    const clipped = truncateSpeech(text, cfg.maxChars);
    if ([...clipped].length < Math.max(1, cfg.minChars)) return null;
    const chunks = splitSpeech(clipped, cfg.chunkMax);
    if (chunks.length === 0) return null;
    const job: SpeechJob = {
      text: clipped,
      chunks,
      silent: opts.silent === true || cfg.playback === 'none',
      source: opts.source,
      produce: (chunk, signal) => this.synthesize(chunk, {
        ...(opts.emotion ? { emotion: opts.emotion } : {}),
        ...(opts.instruct ? { instruct: opts.instruct } : {}),
        ...(opts.voice ? { voice: opts.voice } : {}),
        ...(opts.speed !== undefined ? { speed: opts.speed } : {}),
      }, signal),
    };
    return this.queue.enqueue(job);
  }

  // ———————— 工具 ————————

  private async handleSpeak(args: Record<string, unknown>): Promise<ToolOutcome> {
    const filtered = filterSpeech(asString(args.text), this.styled);
    if (!filtered.text) return { text: 'voice_speak failed: there is nothing to say.', failed: true };
    const silent = args.silent === true || this.cfg.playback === 'none';
    const share = this.cfg.shareAudio || silent;
    const emotion = asString(args.emotion) || filtered.emotion;
    const speed = asNumber(args.speed);
    const style = {
      ...(emotion ? { emotion } : {}),
      ...(asString(args.instruct) ? { instruct: asString(args.instruct) } : {}),
      ...(asString(args.voice) ? { voice: asString(args.voice) } : {}),
      ...(speed !== undefined ? { speed } : {}),
    };

    // 要交附件时不切块:直接合成一整段,合成完就回执;播放交给队列。
    if (share) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('timeout')), this.cfg.timeoutMs);
      try {
        const audio = await this.synthesize(filtered.text, style, controller.signal);
        if (!silent) {
          this.queue.enqueue({
            text: filtered.text,
            chunks: [filtered.text],
            silent: false,
            source: 'tool:voice_speak',
            produce: async () => audio,
          });
        }
        return this.spokenOutcome(audio, audio.seconds ?? 0, silent);
      } catch (error) {
        return { text: `voice_speak failed: ${error instanceof Error ? error.message : String(error)}`, failed: true };
      } finally {
        clearTimeout(timer);
      }
    }

    const enqueued = this.enqueue(filtered.text, { source: 'tool:voice_speak', ...style });
    if (!enqueued) return { text: 'voice_speak failed: the line is too short after filtering.', failed: true };
    const first = await within(Promise.race([
      enqueued.started.then(() => 'started' as const),
      enqueued.done.then((r) => r),
    ]), 30_000);
    if (first === 'timeout') return { text: 'Voice is still preparing; the line will play when ready.' };
    if (first !== 'started' && !first.ok) {
      return { text: `voice_speak failed: ${first.error ?? 'cancelled'}`, failed: true };
    }
    return this.spokenOutcome(undefined, 0, false);
  }

  private async handleStyle(args: Record<string, unknown>): Promise<ToolOutcome> {
    const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(args, key);
    const model = this.cfg.model.trim();
    if (!model) {
      // 还没选模型时写到全局回落值;模型页仍可之后覆盖。
      const patch: Partial<VoiceConfigSection> = {};
      if (has('emotion')) patch.defaultEmotion = asString(args.emotion).slice(0, 40);
      if (has('instruct')) patch.defaultInstruct = asString(args.instruct).slice(0, 500);
      if (has('voice')) patch.voice = asString(args.voice).slice(0, 200);
      if (has('speed')) {
        const speed = asNumber(args.speed);
        if (speed !== undefined) patch.speed = Math.min(2, Math.max(0.5, speed));
      }
      if (Object.keys(patch).length > 0) {
        this.opts.persist(patch);
        return { text: `Voice style updated. ${this.styleSummary()}` };
      }
      return { text: this.styleSummary() };
    }

    const current = modelStyle(this.cfg, model);
    const next: VoiceModelStyle = { ...current };
    if (has('emotion')) next.defaultEmotion = asString(args.emotion).slice(0, 40);
    if (has('instruct')) next.defaultInstruct = asString(args.instruct).slice(0, 500);
    if (has('voice')) next.voice = asString(args.voice).slice(0, 200);
    if (has('speed')) {
      const speed = asNumber(args.speed);
      if (speed !== undefined) next.speed = Math.min(2, Math.max(0.5, speed));
    }
    if (Object.keys(next).some((key) => next[key as keyof VoiceModelStyle] !== current[key as keyof VoiceModelStyle])) {
      const modelStyles: VoiceConfigSection['modelStyles'] = { ...(this.cfg.modelStyles ?? {}), [model]: next };
      this.cfg.modelStyles = modelStyles;
      this.opts.persist({ modelStyles });
      return { text: `Voice style updated. ${this.styleSummary()}` };
    }
    return { text: this.styleSummary() };
  }

  private styleSummary(): string {
    const cfg = this.styled;
    return `Voice: ${cfg.voice || 'default'}; emotion: ${cfg.defaultEmotion || 'neutral'}; `
      + `direction: ${cfg.defaultInstruct || 'none'}; speed: ${cfg.speed}.`;
  }

  private spokenOutcome(audio: TtsAudio | undefined, seconds: number, silent: boolean): ToolOutcome {
    const duration = seconds > 0.05 ? ` (${seconds.toFixed(1)} s)` : '';
    const text = silent
      ? `Synthesized one line${duration} without playing.`
      : `Said one line${duration} on this computer.`;
    if (!audio) return { text };
    // silent 的目的就是把音频交给别的渠道;不带附件等于白合成。
    if (!this.cfg.shareAudio && !silent) return { text };
    const ext = audio.mime.includes('mpeg') ? 'mp3' : 'wav';
    return {
      text,
      blobs: [{
        bytes: audio.bytes,
        mime: audio.mime,
        name: `voice.${ext}`,
        fallbackText: 'Spoken audio',
      }],
    };
  }

  // ———————— 合成与出口 ————————

  /**
   * 语义字段按 emotionMode 只发一种:instruct 发指令,categorical 发情绪,
   * basic 发语速,tags/none 不发;voice/model/format 每次都带。
   */
  private async synthesize(
    text: string,
    style: { emotion?: string; instruct?: string; voice?: string; speed?: number },
    signal: AbortSignal,
  ): Promise<TtsAudio> {
    const cfg = this.styled;
    const resolved = resolveStyle(cfg, style);
    const request: TtsRequest = {
      text,
      format: cfg.format,
      signal,
      ...(style.voice ? { voice: style.voice } : {}),
    };
    switch (cfg.emotionMode) {
      case 'instruct': {
        const instruct = buildInstruct(resolved);
        if (instruct) request.instruct = instruct;
        break;
      }
      case 'categorical':
        request.emotion = resolved.emotion || '平静';
        break;
      case 'basic':
        request.speed = resolved.speed;
        break;
      default:
        break;
    }
    try {
      const audio = await this.service.synthesize(request, signal);
      this.markService({ ok: true });
      return audio;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.markService({ ok: false, detail });
      void this.pushFailure(detail, { source: 'synthesize', chars: [...text].length });
      throw error;
    }
  }

  private async emitVoice(audio: TtsAudio, job: SpeechJob, chunk: string): Promise<void> {
    const host = this.host;
    if (!host) return;
    try {
      await host.pushEvent({
        type: 'tts.voice',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text: `Spoken line: ${chunk.slice(0, 100)}`,
        meta: { source: job.source, voice: this.styled.voice, emotion: this.styled.defaultEmotion },
        blobs: [{
          bytes: audio.bytes,
          mime: audio.mime,
          name: `voice.${audio.mime.includes('mpeg') ? 'mp3' : 'wav'}`,
          fallbackText: 'Spoken audio',
        }],
      }, { deliver: false });
    } catch (error) {
      this.log.warn('声音事件投递失败', { err: error instanceof Error ? error.message : String(error) });
    }
  }

  private async pushFailure(detail: string, meta: Record<string, unknown>): Promise<void> {
    const host = this.host;
    if (!host) return;
    // 服务长时间不可用时,连续失败会反复出现;事件留一条,日志照常。
    const now = this.deps.now();
    if (now - this.lastFailureAt < 30_000) return;
    this.lastFailureAt = now;
    try {
      await host.pushEvent({
        type: 'voice.failed',
        ts: nowIso(this.opts.timezone),
        source: this.id,
        origin: 'internal',
        senderKey: this.id,
        text: `Voice failed: ${detail}`,
        meta,
      }, { deliver: false });
    } catch { /* 只归档,失败就只留日志 */ }
  }

  // ———————— 状态 ————————

  private markService(state: Pick<ServiceState, 'ok' | 'detail'>): void {
    const previous = this.serviceState;
    this.serviceState = { ...state, at: this.deps.now() };
    if (previous?.ok !== state.ok) {
      if (state.ok) this.log.info('语音服务可用');
      else this.log.warn('语音服务不可用', { detail: state.detail ?? '' });
    }
  }

  private async probe(): Promise<void> {
    if (this.probing) return;
    this.probing = true;
    try {
      const health: ServiceHealth = await this.service.health();
      this.markService({
        ok: health.ok && health.ready,
        detail: health.detail ?? health.status,
      });
    } catch (error) {
      this.markService({ ok: false, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      this.probing = false;
    }
  }

  private maybeRefresh(): void {
    if (!this.started) return;
    const now = this.deps.now();
    if (!this.probing && (this.serviceState === null || now - this.serviceState.at > HEALTH_TTL_MS)) {
      void this.probe();
    }
  }

  private ensureTempDir(): string {
    if (this.tempDir) return this.tempDir;
    const base = join(this.opts.dataDir || tmpdir(), 'voice');
    try {
      mkdirSync(base, { recursive: true });
      this.tempDir = mkdtempSync(join(base, 'tmp-'));
    } catch {
      this.tempDir = mkdtempSync(join(tmpdir(), 'cortico-voice-'));
    }
    return this.tempDir;
  }

  private writeTemp(bytes: Uint8Array, mime: string): string {
    const dir = this.ensureTempDir();
    const ext = mime.includes('mpeg') ? 'mp3' : 'wav';
    const path = join(dir, `line-${++this.tempSeq}.${ext}`);
    writeFileSync(path, bytes);
    return path;
  }
}

export { VOICE_DEFAULTS, VOICE_ID };
