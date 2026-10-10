import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const entry = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const secret = 'pool-password-that-must-stay-private';

function startWithPool(accounts) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ZLIBRARY_EMAIL: '',
        ZLIBRARY_PASSWORD: '',
        ZLIBRARY_ACCOUNTS: accounts,
        LOG_LEVEL: 'debug',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('MCP startup timed out'));
    }, 4000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('\n')) child.kill();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    child.stdin.on('error', () => {}); // Invalid configuration may exit before stdin is read.
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2025-11-25', capabilities: {},
        clientInfo: { name: 'account-pool-test', version: '1.0.0' },
      },
    }) + '\n');
  });
}

test('a pool-only configuration starts with a valid MCP response and no missing-credential warning', async () => {
  const result = await startWithPool(JSON.stringify([{ email: 'pool@example.com', password: secret }]));
  const response = JSON.parse(result.stdout.trim());
  expect(response.id).toBe(1);
  expect(response.result.serverInfo.name).toBe('zlibrary-mcp');
  expect(result.stderr).not.toContain('Missing environment variable');
  expect(result.stdout + result.stderr).not.toContain(secret);
});

test.each([
  secret,
  '[]',
  '{}',
  JSON.stringify([{ email: 'pool@example.com', password: 123 }]),
  JSON.stringify([{ email: ' ', password: secret }]),
  JSON.stringify([
    { email: 'pool@example.com', password: secret },
    { email: ' POOL@example.com ', password: secret },
  ]),
])('invalid pool configuration exits without exposing credentials: case %#', async (accounts) => {
  const result = await startWithPool(accounts);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('ZLIBRARY_ACCOUNTS');
  expect(result.stderr).not.toContain(secret);
  expect(result.stderr).not.toContain('pool@example.com');
});
