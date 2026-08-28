/** Subprocess bridge to `python -m geocore run` (JSON envelope on stdout). */

import { spawn } from 'node:child_process';
import type { Envelope, GisAction } from './types.js';

const MAX_STDOUT_BYTES = 64 * 1024 * 1024;

export interface BridgeOptions {
  pythonCmd: string;
  workdir: string;
  timeoutMs: number;
}

/**
 * 校验可执行命令名：只允许普通路径成分字符，绝不接受 shell 元字符。
 * 该值可能来自环境变量/插件配置，必须在进入 spawn 前把守。
 */
const SHELL_META = /[;&|<>$\n\r`"']/;

export function assertSafeExecutable(cmd: string): string {
  if (!cmd || cmd.length > 400 || SHELL_META.test(cmd)) {
    throw new BridgeError(
      'E_BAD_REQUEST',
      `pythonCmd 含非法字符或为空：${JSON.stringify(cmd.slice(0, 64))}`,
      { allowed: '可执行文件路径，不含 shell 元字符' },
    );
  }
  return cmd;
}

function treeKill(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    const args = ['/pid', String(pid), '/T', '/F'];
    const killer = spawn('taskkill', args, { shell: false, windowsHide: true });
    killer.on('error', () => {/* best effort */});
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {/* already gone */}
    }
  }
}

export class BridgeError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }
}

export class PythonBridge {
  constructor(private readonly opts: BridgeOptions) {}

  async call<T = Record<string, unknown>>(
    action: GisAction,
    payload: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const envelope = await this.rawCall(action, payload, signal);
    if (!envelope.ok || envelope.error) {
      const err = envelope.error ?? { code: 'E_INTERNAL', message: 'empty envelope error' };
      throw new BridgeError(err.code, err.message, err.details);
    }
    return envelope.result as T;
  }

  private rawCall(action: GisAction, payload: Record<string, unknown>,
                  signal?: AbortSignal): Promise<Envelope> {
    // 可执行名通过白名单校验后，以参数数组 + shell:false 方式启动，无任何字符串拼接
    const executable = assertSafeExecutable(this.opts.pythonCmd);
    const pythonArgs = ['-m', 'geocore', 'run', '--workdir', this.opts.workdir];
    const request = JSON.stringify({ action, ...payload });

    return new Promise<Envelope>((resolve, reject) => {
      const child = spawn(executable, pythonArgs, {
        cwd: this.opts.workdir,
        windowsHide: true,
        shell: false,
      });

      const chunks: Buffer[] = [];
      let bytes = 0;
      let timedOut = false;
      let aborted = false;
      let oversized = false;

      const abortListener = () => {
        if (child.exitCode === null) {
          aborted = true;
          treeKill(child.pid);
        }
      };
      signal?.addEventListener('abort', abortListener, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        treeKill(child.pid);
      }, Math.max(1000, this.opts.timeoutMs));

      const finish = (fn: () => void) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortListener);
        fn();
      };

      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        chunks.push(chunk);
        if (bytes > MAX_STDOUT_BYTES) {
          oversized = true;
          treeKill(child.pid);
        }
      });

      // 正常路径忽略库告警噪音；仅在封套解析失败时作为诊断附带
      let stderrTail = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
      });

      child.on('error', (err) => finish(() =>
        reject(new BridgeError('E_BRIDGE_SPAWN',
          `无法启动 Python（${this.opts.pythonCmd}）：${err.message}`,
          { hint: '请检查插件配置的 pythonCmd 是否指向可用的解释器' }))));

      child.on('close', (code) => {
        if (aborted) {
          return finish(() => reject(new BridgeError('E_BRIDGE_ABORTED',
            'GeoCore 调用被取消信号终止', { action })));
        }
        if (timedOut) {
          return finish(() => reject(new BridgeError('E_BRIDGE_TIMEOUT',
            `GeoCore 调用超时（>${this.opts.timeoutMs} ms）已被终止`,
            { action })));
        }
        if (oversized) {
          return finish(() => reject(new BridgeError('E_BRIDGE_OVERSIZED_OUTPUT',
            'Python 输出超过 64MB 上限，已终止',
            { action })));
        }
        const text = Buffer.concat(chunks).toString('utf8');
        const envelope = parseLastEnvelope(text);
        if (!envelope) {
          return finish(() => reject(new BridgeError('E_BRIDGE_BROKEN_OUTPUT',
            `Python 进程未输出合法 JSON 封套（exit=${code}）`,
            { stdout_head: text.slice(0, 600), stderr_tail: stderrTail })));
        }
        finish(() => resolve(envelope));
      });

      try {
        child.stdin.write(request);
        child.stdin.end();
      } catch (err) {
        finish(() => reject(new BridgeError('E_BRIDGE_SPAWN', `写入请求失败:${String(err)}`)));
      }
    });
  }
}

function parseLastEnvelope(text: string): Envelope | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Envelope;
      if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) {
        return parsed;
      }
    } catch {
      // 继续向前找（某些库可能打印含 { 的日志行）
    }
  }
  return null;
}
