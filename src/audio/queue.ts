/**
 * 朗读队列:一次念一段,段内按块合成与播放;可以整队清空。
 * 合成与播放分离,播放器可替换(测试用假播放器)。
 */
import type { Logger } from 'cortico/core/types.ts';
import type { PlaybackMode, TtsAudio } from '../types.ts';
import type { AudioPlayer, PlayResult } from './player.ts';

export interface SpeechJob {
  /** 日志与回执里的正文。 */
  text: string;
  /** 已切好的块;唱歌这类不切的只有一块。 */
  chunks: string[];
  /** 合成一块。 */
  produce(chunk: string, signal: AbortSignal): Promise<TtsAudio>;
  /** 合成但不播放。 */
  silent: boolean;
  source: string;
}

export interface JobResult {
  ok: boolean;
  cancelled: boolean;
  seconds: number;
  chunks: number;
  audios: TtsAudio[];
  error?: string;
}

export interface QueueSettings {
  playback: PlaybackMode;
  volume: number;
  gapMs: number;
}

export interface QueueDeps {
  player: AudioPlayer | null;
  settings(): QueueSettings;
  log: Logger;
  sleep(ms: number): Promise<void>;
  /** 把一块音频写到临时文件,返回路径;播放完由队列删除。 */
  writeTemp(bytes: Uint8Array, mime: string): string;
  removeTemp(path: string): void;
  /** playback=event 时把音频交给事件出口。 */
  emit?(audio: TtsAudio, job: SpeechJob, chunk: string): Promise<void> | void;
}

export interface Enqueued {
  started: Promise<void>;
  done: Promise<JobResult>;
}

interface Item {
  job: SpeechJob;
  ctrl: AbortController;
  started: () => void;
  resolve: (result: JobResult) => void;
  cancelled: boolean;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export class SpeechQueue {
  private readonly items: Item[] = [];
  private current: Item | null = null;
  private pumping = false;
  private closed = false;

  constructor(private readonly deps: QueueDeps) {}

  enqueue(job: SpeechJob): Enqueued {
    const start = deferred<void>();
    const done = deferred<JobResult>();
    const item: Item = {
      job,
      ctrl: new AbortController(),
      started: () => start.resolve(),
      resolve: done.resolve,
      cancelled: false,
    };
    this.items.push(item);
    void this.pump();
    return { started: start.promise, done: done.promise };
  }

  stats(): { queued: number; speaking: boolean } {
    return { queued: this.items.length + (this.current ? 1 : 0), speaking: this.current !== null };
  }

  /** 停掉正在放的,丢掉排队的;已排队的 started/done 立即收束。 */
  hush(): void {
    this.deps.player?.hush();
    const current = this.current;
    if (current) {
      current.cancelled = true;
      current.ctrl.abort(new Error('hushed'));
    }
    for (const item of this.items.splice(0)) {
      item.cancelled = true;
      item.ctrl.abort(new Error('hushed'));
      item.started();
      item.resolve({ ok: false, cancelled: true, seconds: 0, chunks: 0, audios: [] });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.hush();
    await this.deps.player?.close();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.items.length) {
        const item = this.items.shift()!;
        if (item.cancelled) continue;
        this.current = item;
        try {
          const result = await this.speak(item);
          item.resolve(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.deps.log.warn('朗读失败', { source: item.job.source, err: message });
          item.started();
          item.resolve({ ok: false, cancelled: item.cancelled, seconds: 0, chunks: 0, audios: [], error: message });
        } finally {
          this.current = null;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async speak(item: Item): Promise<JobResult> {
    const { job } = item;
    const chunks = job.chunks.filter((c) => c.trim());
    if (chunks.length === 0) {
      item.started();
      return { ok: false, cancelled: false, seconds: 0, chunks: 0, audios: [], error: 'nothing to speak' };
    }

    const settings = this.deps.settings();
    const audios: TtsAudio[] = [];
    let seconds = 0;
    let first = true;
    let next: Promise<TtsAudio> | null = this.produce(item, chunks[0]!);
    let lastPlay: PlayResult = 'played';

    const finishStart = (): void => {
      if (!first) return;
      first = false;
      item.started();
    };
    const dropNext = (): void => { if (next) void next.catch(() => {}); };

    for (let i = 0; i < chunks.length; i++) {
      const audio = await next!;
      next = i + 1 < chunks.length ? this.produce(item, chunks[i + 1]!) : null;
      if (item.cancelled) { dropNext(); break; }
      audios.push(audio);
      seconds += audio.seconds ?? 0;

      if (job.silent || settings.playback === 'none') {
        finishStart();
      } else if (settings.playback === 'event' && this.deps.emit) {
        await this.deps.emit(audio, job, chunks[i]!);
        finishStart();
      } else if (this.deps.player) {
        const file = this.deps.writeTemp(audio.bytes, audio.mime);
        try {
          const play = this.deps.player.play(file, settings.volume);
          finishStart();
          lastPlay = await play;
        } finally {
          this.deps.removeTemp(file);
        }
        if (lastPlay === 'cut' || item.cancelled) { dropNext(); break; }
        if (lastPlay === 'failed') {
          dropNext();
          return {
            ok: false, cancelled: item.cancelled, seconds, chunks: audios.length, audios,
            error: 'local playback failed',
          };
        }
      } else {
        finishStart();
        dropNext();
        return {
          ok: false, cancelled: item.cancelled, seconds, chunks: audios.length, audios,
          error: 'no local audio player',
        };
      }

      if (i + 1 < chunks.length && settings.gapMs > 0) await this.deps.sleep(settings.gapMs);
    }

    return {
      ok: !item.cancelled,
      cancelled: item.cancelled,
      seconds,
      chunks: audios.length,
      audios,
    };
  }

  private produce(item: Item, chunk: string): Promise<TtsAudio> {
    return item.job.produce(chunk, item.ctrl.signal).catch((error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error));
    });
  }
}
