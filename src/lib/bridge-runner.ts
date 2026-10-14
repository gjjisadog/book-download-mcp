import { sessionEnvironment, acceptSessionResponse, clearSessions } from './session-cache.js';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { AsyncLocalStorage } from 'async_hooks';
import * as path from 'path';
import { ZLibraryError, TimeoutError, PythonBridgeError } from './errors.js';

export interface BridgeOptions {
  pythonPath: string;
  scriptPath: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  mode?: string;
}
const requestContext = new AsyncLocalStorage<AbortSignal | undefined>();
export function withPythonRequest<T>(signal: AbortSignal | undefined, action: () => T): T {
  return requestContext.run(signal, action);
}
const children = new Set<ChildProcess>();
function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    /* The process may already have exited. */
  }
}
let cleanupInstalled = false;
function installCleanup(): void {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  process.once('exit', () => {
    for (const child of children) killTree(child, 'SIGKILL');
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      for (const child of children) killTree(child, 'SIGKILL');
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

/** Bounded execution shared by the public bridge and MCP tool wrappers. */
export function runPythonBridge(script: string, options: BridgeOptions): Promise<string[]> {
  const signal = options.signal ?? requestContext.getStore();
  if (signal?.aborted)
    return Promise.reject(
      new ZLibraryError('Python request cancelled', 'CANCELLED', undefined, false),
    );
  const configured = Number(process.env.PYTHON_BRIDGE_TIMEOUT_MS || 180000);
  const timeoutMs =
    options.timeoutMs ?? (Number.isFinite(configured) && configured > 0 ? configured : 180000);
  return new Promise((resolve, reject) => {
    const environment = sessionEnvironment(options.env ?? process.env);
    const child = spawn(
      options.pythonPath,
      [path.join(options.scriptPath, script), ...options.args],
      {
        detached: process.platform !== 'win32',
        env: environment,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);
    installCleanup();
    let stdout = '',
      stderr = '',
      settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else {
        try {
          stdout = acceptSessionResponse(stdout, environment);
        } catch {
          /* Parser reports malformed output. */
        }
        resolve(stdout.trim() ? stdout.trim().split('\n') : []);
      }
    };
    const stop = (error: Error) => {
      killTree(child);
      const forceKill = setTimeout(() => {
        killTree(child, 'SIGKILL');
        children.delete(child);
      }, 250);
      forceKill.unref();
      finish(error);
    };
    const abort = () =>
      stop(new ZLibraryError('Python request cancelled', 'CANCELLED', undefined, false));
    const deadline = new TimeoutError('Python bridge deadline exceeded');
    deadline.retryable = false;
    const timer = setTimeout(() => stop(deadline), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const collect = (value: Buffer, isError: boolean) => {
      if (isError) stderr += value.toString();
      else stdout += value.toString();
      if (stdout.length + stderr.length > 8 * 1024 * 1024)
        stop(new PythonBridgeError('Python bridge output limit exceeded', undefined, false));
    };
    child.stdout?.on('data', (value: Buffer) => collect(value, false));
    child.stderr?.on('data', (value: Buffer) => collect(value, true));
    child.on('error', () => {
      children.delete(child);
      finish(new PythonBridgeError('Failed to start Python process', undefined, false));
    });
    child.on('close', (code) => {
      children.delete(child);
      if (code === 0) {
        finish();
        return;
      }
      // Only use the structured error record, never raw logs/query/traceback.
      for (const line of stderr.trim().split('\n').reverse()) {
        try {
          const data = JSON.parse(line);
          if (typeof data.error === 'string' && typeof data.code === 'string') {
            if (data.code === 'AUTH_ERROR') clearSessions();
            finish(new ZLibraryError(data.error, data.code, undefined, data.retryable === true));
            return;
          }
        } catch {
          /* Skip diagnostic lines. */
        }
      }
      finish(new PythonBridgeError(`Python process exited with code ${code}`, undefined, false));
    });
    // Cancellation can arrive between spawn and listener registration.
    if (signal?.aborted) abort();
  });
}
