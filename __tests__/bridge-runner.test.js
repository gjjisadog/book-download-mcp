import { jest, test, expect, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'events';
const spawnMock = jest.fn();
const taskkill = jest.fn();
jest.unstable_mockModule('child_process', () => ({ spawn: spawnMock, execFileSync: taskkill }));
const { runPythonBridge, withPythonRequest } = await import('../lib/bridge-runner.js');
let child, kill;
const options = { pythonPath: '/python', scriptPath: '/bridge', args: ['search', '{}'], timeoutMs: 1000 };
beforeEach(() => {
  child = new EventEmitter(); child.pid = 43210;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  spawnMock.mockReturnValue(child);
  kill = jest.spyOn(process, 'kill').mockImplementation(() => true);
});
afterEach(() => { child.pid = undefined; kill.mockRestore(); });
test('parses structured auth failure and drops raw diagnostic lines', async () => {
  const result = runPythonBridge('python_bridge.py', options);
  child.stderr.emit('data', Buffer.from('private query / secret\n' + JSON.stringify({ error: 'Login rejected', code: 'AUTH_ERROR', retryable: false }) + '\n'));
  child.emit('close', 1);
  await expect(result).rejects.toMatchObject({ message: 'Login rejected', code: 'AUTH_ERROR', retryable: false });
});
test('returns lines on success, empty output on empty response', async () => {
  let result = runPythonBridge('python_bridge.py', options);
  child.stdout.emit('data', Buffer.from('one\ntwo\n')); child.emit('close', 0);
  expect(await result).toEqual(['one', 'two']);
  result = runPythonBridge('python_bridge.py', options); child.emit('close', 0);
  expect(await result).toEqual([]);
});
test('abort terminates the process group and refuses pre-cancelled requests', async () => {
  const controller = new AbortController();
  const result = withPythonRequest(controller.signal, () => runPythonBridge('python_bridge.py', options));
  controller.abort();
  await expect(result).rejects.toMatchObject({ code: 'CANCELLED', retryable: false });
  expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGTERM');
  child.emit('close', null);
  await expect(withPythonRequest(controller.signal, () => runPythonBridge('python_bridge.py', options))).rejects.toMatchObject({ code: 'CANCELLED' });
});
test('deadline kills a hung worker and escalates when it ignores TERM', async () => {
  jest.useFakeTimers();
  try {
    const result = runPythonBridge('python_bridge.py', { ...options, timeoutMs: 10 });
    const rejected = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await jest.advanceTimersByTimeAsync(10); await rejected;
    await jest.advanceTimersByTimeAsync(250);
    expect(kill).toHaveBeenCalledWith(-child.pid, 'SIGKILL');
  } finally { jest.useRealTimers(); }
});
test('bounds output and handles an already exited process', async () => {
  kill.mockImplementation(() => { throw new Error('ESRCH'); });
  const result = runPythonBridge('python_bridge.py', options);
  child.stdout.emit('data', Buffer.from('x'.repeat(8 * 1024 * 1024 + 1)));
  await expect(result).rejects.toMatchObject({ retryable: false }); child.emit('close', 1);
});
test('spawn errors carry no raw environment or stderr', async () => {
  const result = runPythonBridge('python_bridge.py', options); child.emit('error', new Error('secret env'));
  await expect(result).rejects.toThrow('Failed to start Python process');
});
