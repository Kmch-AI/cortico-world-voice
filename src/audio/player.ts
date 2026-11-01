/**
 * 本机播放。不引原生模块:
 * - Windows:常驻一个 PowerShell,用 winmm 的 MCI 一片一片 `play … wait`;
 * - macOS:`afplay`;
 * - Linux:`paplay` / `aplay` / `ffplay` 依次尝试。
 * 只支持 wav / mp3;播放失败返回 failed,由调用方决定要不要发事件。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from 'cortico/core/types.ts';

export type PlayResult = 'played' | 'cut' | 'failed';

export interface AudioPlayer {
  /** 预启动播放器,省掉第一片的启动时间;失败不影响后续播放。 */
  warm(dir: string): Promise<void>;
  /** 放一片,resolve 时声音已结束、被 hush 或失败。 */
  play(file: string, volume: number): Promise<PlayResult>;
  /** 立刻停下正在放的一片。 */
  hush(): void;
  close(): Promise<void>;
}

/** 单片最长等待;播放器卡住时不吊死队列。 */
const CLIP_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 10_000;

const PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -Namespace WinMM -Name MCI -MemberDefinition '[DllImport(\"winmm.dll\", CharSet = CharSet.Auto)] public static extern int mciSendString(string cmd, System.Text.StringBuilder ret, int len, System.IntPtr hwnd);'",
  "[Console]::Out.WriteLine('READY')",
  '[Console]::Out.Flush()',
  'while ($true) {',
  '  $line = [Console]::In.ReadLine()',
  '  if ($null -eq $line) { break }',
  '  if ($line -eq "QUIT") { break }',
  '  $vol = 1000',
  '  $file = $line',
  '  $tab = $line.IndexOf([char]9)',
  '  if ($tab -ge 0) {',
  '    $vol = [int]$line.Substring(0, $tab)',
  '    $file = $line.Substring($tab + 1)',
  '  }',
  '  $audioType = "mpegvideo"',
  '  if ([System.IO.Path]::GetExtension($file).ToLower() -eq ".wav") { $audioType = "waveaudio" }',
  '  $code = [WinMM.MCI]::mciSendString("open `"$file`" type $audioType alias cvplay", $null, 0, [System.IntPtr]::Zero)',
  '  if ($code -ne 0) { [Console]::Out.WriteLine("FAIL $code"); [Console]::Out.Flush(); continue }',
  '  [WinMM.MCI]::mciSendString("setaudio cvplay volume to $vol", $null, 0, [System.IntPtr]::Zero) | Out-Null',
  '  $code = [WinMM.MCI]::mciSendString("play cvplay wait", $null, 0, [System.IntPtr]::Zero)',
  '  [WinMM.MCI]::mciSendString("close cvplay", $null, 0, [System.IntPtr]::Zero) | Out-Null',
  '  if ($code -ne 0) { [Console]::Out.WriteLine("FAIL $code") } else { [Console]::Out.WriteLine("DONE") }',
  '  [Console]::Out.Flush()',
  '}',
].join('\r\n');

interface Pending {
  resolve: (result: PlayResult) => void;
  timer: NodeJS.Timeout;
  settled: boolean;
}

class WindowsPlayer implements AudioPlayer {
  private child: ChildProcess | null = null;
  private ready: Promise<boolean> | null = null;
  private pending: Pending | null = null;
  private scriptPath: string | null = null;
  private dir: string | null = null;
  private tail = '';

  constructor(private readonly log: Logger) {}

  async warm(dir: string): Promise<void> {
    this.dir = dir;
    try { mkdirSync(dir, { recursive: true }); } catch { /* 用临时目录即可 */ }
    await this.ensure();
  }

  private async ensure(): Promise<boolean> {
    if (this.child) return this.ready ?? true;
    const dir = this.dir;
    if (!dir) return false;
    if (!this.scriptPath) {
      this.scriptPath = join(dir, 'voice-player.ps1');
      writeFileSync(this.scriptPath, PS_SCRIPT, 'utf8');
    }
    let mark: (ok: boolean) => void = () => {};
    this.ready = new Promise<boolean>((resolve) => { mark = resolve; });
    let child: ChildProcess;
    try {
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch (error) {
      this.log.warn('播放器启动失败', { err: error instanceof Error ? error.message : String(error) });
      this.ready = null;
      return false;
    }
    this.child = child;
    this.tail = '';
    const timer = setTimeout(() => mark(false), READY_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      this.tail += chunk;
      let nl = this.tail.indexOf('\n');
      while (nl >= 0) {
        const line = this.tail.slice(0, nl).trim();
        this.tail = this.tail.slice(nl + 1);
        if (line === 'READY') {
          clearTimeout(timer);
          mark(true);
        } else if (line === 'DONE' || line.startsWith('FAIL')) {
          this.finish(line === 'DONE' ? 'played' : 'failed');
        }
        nl = this.tail.indexOf('\n');
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      mark(false);
      this.drop(child, 'failed', error.message);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      mark(false);
      this.drop(child, 'failed');
    });
    return this.ready;
  }

  private finish(result: PlayResult): void {
    const pending = this.pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve(result);
  }

  private drop(child: ChildProcess, result: PlayResult, detail?: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    if (detail) this.log.warn('播放器退出', { err: detail });
    this.finish(result);
  }

  async play(file: string, volume: number): Promise<PlayResult> {
    const ok = this.child ? true : await this.ensure();
    const child = this.child;
    if (!ok || !child?.stdin?.writable) return 'failed';
    this.finish('cut');
    const level = Math.round(Math.min(1, Math.max(0, volume)) * 1000);
    return new Promise<PlayResult>((resolve) => {
      const timer = setTimeout(() => {
        this.finish('failed');
        this.hush();
      }, CLIP_TIMEOUT_MS);
      this.pending = { resolve, timer, settled: false };
      child.stdin!.write(`${level}\t${file}\n`, (error) => {
        if (error) this.finish('failed');
      });
    });
  }

  hush(): void {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.finish('cut');
    if (!child) return;
    try { child.stdin?.end('QUIT\n'); } catch { /* 已经没了 */ }
    try { child.kill(); } catch { /* 已经没了 */ }
  }

  async close(): Promise<void> {
    const child = this.child;
    this.hush();
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 1000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

class CommandPlayer implements AudioPlayer {
  private child: ChildProcess | null = null;
  private cut = false;

  constructor(private readonly log: Logger, private readonly kind: 'afplay' | 'linux') {}

  async warm(): Promise<void> {}

  private command(file: string, volume: number): { cmd: string; args: string[] } {
    if (this.kind === 'afplay') return { cmd: 'afplay', args: ['-v', String(volume), file] };
    return { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-volume', String(Math.round(volume * 100)), file] };
  }

  private run(cmd: string, args: string[]): Promise<PlayResult> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(cmd, args, { stdio: 'ignore', windowsHide: true });
      } catch {
        resolve('failed');
        return;
      }
      this.child = child;
      this.cut = false;
      const timer = setTimeout(() => { this.hush(); resolve('failed'); }, CLIP_TIMEOUT_MS);
      child.once('error', () => { clearTimeout(timer); this.child = null; resolve('failed'); });
      child.once('exit', (code) => {
        clearTimeout(timer);
        this.child = null;
        resolve(this.cut ? 'cut' : code === 0 ? 'played' : 'failed');
      });
    });
  }

  async play(file: string, volume: number): Promise<PlayResult> {
    const { cmd, args } = this.command(file, volume);
    const result = await this.run(cmd, args);
    if (result !== 'failed' || this.kind === 'afplay') return result;
    // Linux:ffplay 不在就退回系统播放器。
    for (const fallback of [['paplay', [file]], ['aplay', ['-q', file]]] as const) {
      const r = await this.run(fallback[0], [...fallback[1]]);
      if (r !== 'failed') return r;
    }
    this.log.warn('没有可用的播放命令(试过 ffplay / paplay / aplay)');
    return 'failed';
  }

  hush(): void {
    this.cut = true;
    try { this.child?.kill(); } catch { /* 已经没了 */ }
    this.child = null;
  }

  async close(): Promise<void> {
    this.hush();
  }
}

/** 按平台选播放器;不支持的平台返回 null,由 World 报「本机播放不可用」。 */
export function createPlayer(log: Logger): AudioPlayer {
  if (process.platform === 'win32') return new WindowsPlayer(log);
  if (process.platform === 'darwin') return new CommandPlayer(log, 'afplay');
  return new CommandPlayer(log, 'linux');
}
