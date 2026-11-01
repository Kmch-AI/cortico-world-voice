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
import { VOICE_DEFAULTS, VOICE_ID, VOICE_MODELS_KIND, VOICE_OPTIONS_KIND, voiceConfigGroups, voiceText } from './config.ts';
import type { AudioPlayer } from './audio/player.ts';
import { createPlayer } from './audio/player.ts';
import { SpeechQueue, type SpeechJob } from './audio/queue.ts';
import { registerOptions, unregisterOptions } from './options.ts';
import { ServiceClient, type SpeechService } from './service.ts';
import { splitSpeech, truncateSpeech } from './speech/chunk.ts';
import { buildInstruct, resolveStyle } from './speech/style.ts';
import { filterSpeech } from './speech/text.ts';
import { EventPoller, eventTypes, hasKeyword, latestUserText, splitList, VoiceTap } from './triggers.ts';
import { VOICE_TOOL_DECLS } from './tools.ts';
import type {
  ModelOption, ServiceHealth, TtsAudio, TtsRequest, VoiceConfigSection, VoiceOption,
} from './types.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const DEDUPE_WINDOW_MS = 5000;
const HEALTH_INTERVAL_MS = 15_000;
const HEALTH_TTL_MS = 15_000;
const CATALOG_TTL_MS = 10 * 60_000;

export interface VoiceWorldDeps {
  fetch: typeof fetch;
  createPlayer(log: Logger): AudioPlayer | null;
  rng(): number;
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
    rng: () => Math.random(),
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
  private poller: EventPoller | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private started = false;
  private tempDir = '';
  private tempSeq = 0;
  private serviceState: ServiceState | null = null;
  private probing = false;
  private voices: VoiceOption[] = [];
  private voicesAt = 0;
  private voicesSignature = '';
  private voicesLoading = false;
  private models: ModelOption[] = [];
  private modelsAt = 0;
  private modelsSignature = '';
  private modelsLoading = false;
  private readonly lastSpoken = new Map<string, number>();
  private lastFailureAt = 0;
  private readonly modelOptions = (): readonly ModelOption[] => this.models;
  private readonly voiceOptions = (): readonly VoiceOption[] => this.voices;

  constructor(private readonly opts: VoiceWorldOptions) {
    this.log = opts.log ?? nullLogger();
    this.deps = { ...defaultDeps(), ...opts.deps };
    this.service = this.deps.service ?? new ServiceClient({
      fetch: this.deps.fetch,
      secret: (name) => this.opts.secret(name),
      cfg: () => this.cfg,
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
      cfg: () => this.cfg,
      onText: (text, source) => this.consider(text, source),
      onAbort: () => this.queue.hush(),
    });
  }

  private get cfg(): VoiceConfigSection {
    return this.opts.cfg;
  }

  envPromptVars(): Record<string, string> {
    const cfg = this.cfg;
    return {
      'voice.auto': cfg.autoSpeak ? `${Math.round(cfg.autoProbability * 100)}%` : 'off',
      'voice.voice': cfg.voice || 'default',
      'voice.emotion': cfg.defaultEmotion || 'neutral',
      'voice.instruct': cfg.defaultInstruct || 'none',
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
    const cfg = this.cfg;
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
      config: voiceConfigGroups(language),
      links: [{ label: t.servicePage, href: '#/provider/world:service' }],
      promptDocs: [{
        key: 'worlds.voice.envPrompt',
        title: t.envTitle,
        description: '',
        path: ENV_PROMPT_FILE,
        role: 'envPrompt',
        vars: [
          { name: 'voice.auto', description: 'Automatic reading probability, or off.' },
          { name: 'voice.voice', description: 'Current voice id.' },
          { name: 'voice.emotion', description: 'Standing emotion.' },
          { name: 'voice.instruct', description: 'Standing direction.' },
        ],
      }],
    };
  }

  outputTap() {
    const cfg = this.cfg;
    if (!cfg.autoSpeak) return undefined;
    if (!cfg.autoFromText && splitList(cfg.autoTools).length === 0) return undefined;
    return this.tap;
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.started = true;
    this.registerCatalogOptions();
    this.log.info('语音 World 启动', {
      service: serviceHost(this.cfg.serviceUrl),
      playback: this.cfg.playback,
      auto: this.cfg.autoSpeak ? this.cfg.autoProbability : 'off',
    });
    if (this.cfg.playback === 'local') {
      void this.player?.warm(this.ensureTempDir()).catch((error: unknown) => {
        this.log.warn('播放器预热失败', { err: error instanceof Error ? error.message : String(error) });
      });
    }
    this.syncPoller();
    void this.probe();
    this.healthTimer = setInterval(() => { void this.probe(); }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.started = false;
    this.unregisterCatalogOptions();
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
    this.poller?.stop();
    this.poller = null;
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
    if (!cfg.autoSpeak) return;

    const filtered = filterSpeech(raw, cfg);
    if (!filtered.text) return;

    const userText = cfg.explicitTrigger
      ? latestUserText(this.host!, cfg.explicitWindowSec, this.deps.now())
      : '';
    const explicit = filtered.forced || (cfg.explicitTrigger && hasKeyword(userText, cfg.explicitKeywords));
    if (!explicit && this.deps.rng() >= cfg.autoProbability) return;
    if (!this.fresh(filtered.text)) return;

    this.enqueue(filtered.text, {
      source,
      ...(filtered.emotion ? { emotion: filtered.emotion } : {}),
    });
    this.log.debug('自动朗读', { source, explicit, chars: [...filtered.text].length });
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
    const filtered = filterSpeech(asString(args.text), this.cfg);
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
      if (patch.voice !== undefined) void this.refreshVoices(true);
      return { text: `Voice style updated. ${this.styleSummary()}` };
    }
    return { text: this.styleSummary() };
  }

  private styleSummary(): string {
    const cfg = this.cfg;
    return `Voice: ${cfg.voice || 'default'}; emotion: ${cfg.defaultEmotion || 'neutral'}; `
      + `direction: ${cfg.defaultInstruct || 'none'}; speed: ${cfg.speed}; `
      + `automatic: ${cfg.autoSpeak ? `${Math.round(cfg.autoProbability * 100)}%` : 'off'}.`;
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
    const cfg = this.cfg;
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
        meta: { source: job.source, voice: this.cfg.voice, emotion: this.cfg.defaultEmotion },
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
    // 服务长时间不可用时,自动朗读会每句都失败;事件留一条,日志照常。
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

  // ———————— 状态与目录 ————————

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
    // 探活会刷新目录;每次探活都重新登记,停用后重新启用的实例也能接上。
    this.registerCatalogOptions();
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
    // 探活顺带刷新目录;读不到时 refresh 会保留上一次的表。
    await this.refreshVoices(true);
    await this.refreshModels(true);
  }

  private maybeRefresh(): void {
    if (!this.started) return;
    const now = this.deps.now();
    if (!this.probing && (this.serviceState === null || now - this.serviceState.at > HEALTH_TTL_MS)) {
      void this.probe();
    }
    if (now - this.voicesAt > CATALOG_TTL_MS) void this.refreshVoices();
    if (now - this.modelsAt > CATALOG_TTL_MS) void this.refreshModels();
  }

  private async refreshVoices(force = false): Promise<void> {
    const cfg = this.cfg;
    const signature = `${cfg.serviceUrl.trim()}|${cfg.model.trim()}`;
    if (this.voicesLoading && !force) return;
    if (!force && signature === this.voicesSignature && this.deps.now() - this.voicesAt < CATALOG_TTL_MS) return;
    this.voicesLoading = true;
    try {
      const list = await this.service.voices(cfg.model);
      if (signature !== `${this.cfg.serviceUrl.trim()}|${this.cfg.model.trim()}`) return;
      this.voices = list;
      this.voicesSignature = signature;
      this.voicesAt = this.deps.now();
    } catch (error) {
      this.log.debug('音色表读取失败', { err: error instanceof Error ? error.message : String(error) });
    } finally {
      this.voicesLoading = false;
    }
  }

  private async refreshModels(force = false): Promise<void> {
    const signature = this.cfg.serviceUrl.trim();
    if (this.modelsLoading && !force) return;
    if (!force && signature === this.modelsSignature && this.deps.now() - this.modelsAt < CATALOG_TTL_MS) return;
    this.modelsLoading = true;
    try {
      const list = await this.service.models();
      if (signature !== this.cfg.serviceUrl.trim()) return;
      this.models = list;
      this.modelsSignature = signature;
      this.modelsAt = this.deps.now();
    } catch (error) {
      this.log.debug('模型表读取失败', { err: error instanceof Error ? error.message : String(error) });
    } finally {
      this.modelsLoading = false;
    }
  }

  /** 下拉读的是缓存表;服务读不到时保留上一次的结果。当前值由框架补入。 */
  private registerCatalogOptions(): void {
    registerOptions(VOICE_MODELS_KIND, this.modelOptions);
    registerOptions(VOICE_OPTIONS_KIND, this.voiceOptions);
  }

  private unregisterCatalogOptions(): void {
    unregisterOptions(VOICE_MODELS_KIND, this.modelOptions);
    unregisterOptions(VOICE_OPTIONS_KIND, this.voiceOptions);
  }

  private syncPoller(): void {
    const types = eventTypes(this.cfg);
    if (types.size === 0) {
      this.poller?.stop();
      this.poller = null;
      return;
    }
    if (this.poller) return;
    this.poller = new EventPoller({
      host: this.host!,
      types,
      onText: (text, source) => this.consider(text, source),
      log: (message, data) => this.log.warn(message, data),
    });
    this.poller.start();
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

export { VOICE_DEFAULTS, VOICE_ID, VOICE_MODELS_KIND, VOICE_OPTIONS_KIND };
