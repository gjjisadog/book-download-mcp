import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BookCandidate } from './book-selection.js';

const require = createRequire(import.meta.url);
const packages = {
  libgen_mcp: '@jmrp.io/libgen-mcp/cli.js',
  find_a_book: 'find-a-book-mcp/server.js',
} as const;
export type ExternalSource = keyof typeof packages;
const maxFileBytes = 512 * 1024 * 1024;

export function isExternalSource(source: unknown): source is ExternalSource {
  return typeof source === 'string' && Object.hasOwn(packages, source);
}

export function enabledExternalSources(): ExternalSource[] {
  const configured = process.env.BOOKHARBOR_MCP_SOURCES;
  return (configured === undefined ? Object.keys(packages) : configured.split(','))
    .map((name) => name.trim())
    .filter(isExternalSource)
    .filter((name) => {
      try {
        require.resolve(packages[name]);
        return true;
      } catch {
        return false;
      }
    });
}

function identity(book: BookCandidate, source: ExternalSource): Record<string, string> {
  if (typeof book.md5 === 'string' && /^[a-f0-9]{32}$/i.test(book.md5))
    return { md5: book.md5.toLowerCase() };
  if (source === 'libgen_mcp') {
    if (typeof book.doi === 'string' && /^10\.\d{4,9}\/\S{1,500}$/i.test(book.doi))
      return { doi: book.doi };
    const isbn = typeof book.isbn === 'string' ? book.isbn.replace(/[-\s]/g, '') : '';
    if (/^(?:\d{9}[\dXx]|\d{13})$/.test(isbn)) return { isbn };
  }
  throw new Error(
    `${source}: no supported download identifier (MD5${source === 'libgen_mcp' ? ', DOI or ISBN' : ''})`,
  );
}

function toolData(result: any): any {
  if (result.isError) throw new Error('Upstream MCP tool failed');
  let data = result.structuredContent;
  if (!data) {
    const text = result.content
      ?.filter((item: any) => item.type === 'text')
      .map((item: any) => item.text)
      .join('\n');
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Upstream MCP returned invalid JSON');
    }
  }
  if (!data || typeof data !== 'object' || data.error || data.success === false)
    throw new Error('Upstream MCP returned an error');
  return data;
}

async function withUpstream<T>(
  source: ExternalSource,
  run: (client: Client, workingDir: string, signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 60000,
): Promise<T> {
  signal?.throwIfAborted();
  let script: string;
  try {
    script = require.resolve(packages[source]);
  } catch {
    throw new Error(`${source}: optional package missing; run npm install --include=optional`);
  }
  const workingDir = await fs.mkdtemp(path.join(os.tmpdir(), `bookharbor-${source}-`));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const activeSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  // SDK stdio inherits only platform defaults. Never forward account credentials,
  // account-pool state, API keys, or the parent's env-file arguments to a backend.
  const env: Record<string, string> = {
    HOME: workingDir,
    USERPROFILE: workingDir,
    XDG_CACHE_HOME: path.join(workingDir, 'cache'),
    TMPDIR: workingDir,
    TMP: workingDir,
    TEMP: workingDir,
    LIBGEN_MCP_ENV_FILE: path.join(workingDir, 'empty.env'),
    LIBGEN_MCP_TIMEOUT: '10s',
    LIBGEN_MCP_ACTION_TIMEOUT: `${Math.floor(timeoutMs / 1000)}s`,
    LIBGEN_MCP_RETRY_ATTEMPTS: '1',
    LIBGEN_MCP_CONFIRM_DOWNLOADS: 'false',
    LIBGEN_MCP_TELEMETRY: 'false',
    LIBGEN_MCP_MAX_DOWNLOAD_BYTES: String(maxFileBytes),
    LIBGEN_MCP_DOWNLOAD_DIR: workingDir,
  };
  for (const key of [
    'PATH',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
    'no_proxy',
    'LIBGEN_MIRRORS',
    'LIBGEN_MCP_MIRRORS',
  ])
    if (process.env[key]) env[key] = process.env[key]!;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [script],
    cwd: workingDir,
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {});
  const client = new Client({ name: 'bookharbor-source-adapter', version: '1.4.1' });
  const abort = () => {
    void transport.close().catch(() => {});
  };
  activeSignal.addEventListener('abort', abort, { once: true });
  try {
    activeSignal.throwIfAborted();
    await fs.writeFile(env.LIBGEN_MCP_ENV_FILE!, '', { mode: 0o600 });
    await client.connect(transport, { timeout: 15000 });
    return await run(client, workingDir, activeSignal);
  } catch {
    throw new Error(
      `${source}: ${activeSignal.aborted ? 'request cancelled or timed out' : 'upstream request failed'}`,
    );
  } finally {
    clearTimeout(timer);
    activeSignal.removeEventListener('abort', abort);
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    await fs.rm(workingDir, { recursive: true, force: true });
  }
}

export async function searchExternalSource(
  source: ExternalSource,
  query: string,
  count: number,
  signal?: AbortSignal,
) {
  return withUpstream(
    source,
    async (client, _workingDir, activeSignal) => {
      const raw = toolData(
        await client.callTool(
          {
            name: source === 'libgen_mcp' ? 'search' : 'search_books',
            arguments:
              source === 'libgen_mcp'
                ? { query, results_per_page: count > 25 ? 50 : 25, extra_sources: 'always' }
                : { query, page: 1 },
          },
          undefined,
          { signal: activeSignal, timeout: 55000 },
        ),
      );
      const records = source === 'libgen_mcp' ? (raw.results ?? []) : raw.books;
      if (!Array.isArray(records)) throw new Error('Missing upstream book results');
      if (raw.open_access != null && !Array.isArray(raw.open_access))
        throw new Error('Invalid discovery results');
      const books: BookCandidate[] = [],
        discovery: BookCandidate[] = [];
      for (const record of [...records, ...(raw.open_access ?? [])]) {
        if (!record || typeof record !== 'object' || typeof record.title !== 'string') continue;
        const book: BookCandidate = {
          source,
          origin: record.origin || 'libgen',
          title: record.title,
          author: record.author || record.authors || '',
          year: record.year || '',
          language: record.language || '',
          publisher: record.publisher || '',
          extension: String(record.extension || '').toLowerCase(),
          size: record.size || '',
          md5: typeof record.md5 === 'string' ? record.md5.toLowerCase() : '',
          doi: record.doi || '',
          isbn: record.isbn || record.isbns?.[0] || '',
          url: record.full_text_url || record.pdf_url || record.archive_url || '',
          open_access: record.open_access === true,
        };
        try {
          identity(book, source);
          books.push(book);
        } catch {
          discovery.push({ ...book, metadata_only: true });
        }
      }
      return { books: books.slice(0, count), discovery: discovery.slice(0, count) };
    },
    signal,
  );
}

/** A backend writes only to a private staging directory; publish verified bytes atomically. */
export async function downloadExternalSource(
  book: BookCandidate,
  outputDir: string,
  signal?: AbortSignal,
) {
  if (!isExternalSource(book.source)) throw new Error('Unknown external book source');
  const source = book.source,
    id = identity(book, source);
  return withUpstream(
    source,
    async (client, workingDir, activeSignal) => {
      const result = toolData(
        await client.callTool(
          {
            name: source === 'libgen_mcp' ? 'download' : 'download_book',
            arguments:
              source === 'libgen_mcp'
                ? { ...id, path: workingDir }
                : { ...id, title: 'book', dest_dir: workingDir },
          },
          undefined,
          { signal: activeSignal, timeout: 175000 },
        ),
      );
      const filename = source === 'libgen_mcp' ? result.path : result.file_path;
      if (typeof filename !== 'string') throw new Error('Upstream returned no file');
      const staged = await fs.realpath(path.resolve(workingDir, filename));
      const relative = path.relative(await fs.realpath(workingDir), staged);
      const stat = await fs.lstat(path.resolve(workingDir, filename));
      if (
        !relative ||
        relative.startsWith(`..${path.sep}`) ||
        relative === '..' ||
        path.isAbsolute(relative) ||
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        stat.size === 0 ||
        stat.size > maxFileBytes
      )
        throw new Error('Invalid upstream download path or file size');
      if (result.size_bytes !== undefined && result.size_bytes !== stat.size)
        throw new Error('Incomplete upstream download');
      const extension = path.extname(staged).slice(1).toLowerCase();
      if (
        !/^[a-z0-9]{2,8}$/.test(extension) ||
        ['html', 'htm', 'exe', 'sh', 'js'].includes(extension)
      )
        throw new Error('Unsupported downloaded file type');
      const handle = await fs.open(staged, 'r');
      try {
        const prefix = Buffer.alloc(512);
        const { bytesRead } = await handle.read(prefix, 0, 512, 0);
        if (
          /^\s*(?:<!doctype\s+html|<html|<head|<body)/i.test(
            prefix.subarray(0, bytesRead).toString(),
          )
        )
          throw new Error('Upstream returned HTML');
      } finally {
        await handle.close();
      }
      if (id.md5) {
        const hash = createHash('md5');
        for await (const chunk of createReadStream(staged)) {
          activeSignal.throwIfAborted();
          hash.update(chunk);
        }
        if (hash.digest('hex') !== id.md5)
          throw new Error('Downloaded file MD5 does not match the selected version');
      }
      activeSignal.throwIfAborted();
      const directory = path.resolve(outputDir);
      await fs.mkdir(directory, { recursive: true });
      const temporaryDir = await fs.mkdtemp(path.join(directory, '.bookharbor-'));
      const token = createHash('sha256').update(JSON.stringify(id)).digest('hex').slice(0, 12);
      const title =
        String(book.title || 'book')
          .replace(/[^\p{L}\p{N} _-]/gu, '')
          .trim()
          .slice(0, 70) || 'book';
      const target = path.join(
        directory,
        `${title}_${token}_${randomUUID().slice(0, 8)}.${extension}`,
      );
      try {
        const temporaryFile = path.join(temporaryDir, 'book');
        await fs.copyFile(staged, temporaryFile);
        activeSignal.throwIfAborted();
        await fs.link(temporaryFile, target);
      } finally {
        await fs.rm(temporaryDir, { recursive: true, force: true });
      }
      return {
        file_path: target,
        processed_file_path: null,
        source,
        origin: book.origin || 'libgen',
      };
    },
    signal,
    180000,
  );
}
