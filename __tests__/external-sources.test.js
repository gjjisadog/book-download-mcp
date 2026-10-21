import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';

const savedEnv = { ...process.env };
const bytes = Buffer.from('%PDF-1.7\nbook contents for integrity verification\n');
const md5 = createHash('md5').update(bytes).digest('hex');
let config, invoke, roots, targetDir, closes;

beforeEach(async () => {
  jest.resetModules();
  roots = []; closes = 0;
  targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bookharbor-test-output-'));
  invoke = async () => ({ content: [{ type: 'text', text: '{"books":[]}' }] });
  jest.unstable_mockModule('@modelcontextprotocol/sdk/client/stdio.js', () => ({
    StdioClientTransport: class {
      constructor(options) { config = options; roots.push(options.cwd); this.stderr = new PassThrough(); }
      async close() { closes++; }
    },
  }));
  jest.unstable_mockModule('@modelcontextprotocol/sdk/client/index.js', () => ({
    Client: class {
      async connect() {}
      async close() { closes++; }
      async callTool(request, _, options) { return invoke(request, options); }
    },
  }));
});
afterEach(async () => {
  process.env = { ...savedEnv };
  for (const root of roots) expect(await fs.stat(root).catch(() => null)).toBeNull();
  await fs.rm(targetDir, { recursive: true, force: true });
});
const load = () => import('../dist/lib/external-sources.js');
const reply = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

describe('External source discovery and search contracts', () => {
  test('installed optional providers are enabled by default, with a narrow opt-out', async () => {
    delete process.env.BOOKHARBOR_MCP_SOURCES;
    const api = await load();
    expect(api.enabledExternalSources()).toEqual(['libgen_mcp', 'find_a_book']);
    process.env.BOOKHARBOR_MCP_SOURCES = 'find_a_book,unknown';
    expect(api.enabledExternalSources()).toEqual(['find_a_book']);
    process.env.BOOKHARBOR_MCP_SOURCES = '';
    expect(api.enabledExternalSources()).toEqual([]);
    expect(api.isExternalSource('__proto__')).toBe(false);
  });

  test('libgen-mcp structured results and open access metadata are normalized separately', async () => {
    invoke = async request => {
      expect(request).toEqual({ name: 'search', arguments: { query: 'Book', results_per_page: 50, extra_sources: 'always' } });
      return { structuredContent: { results: [{ title: 'Book', authors: 'Author', md5: md5.toUpperCase(), extension: 'PDF', origin: 'libgen' }], open_access: [{ title: 'Article', doi: '10.1234/example', authors: 'Researcher', origin: 'crossref', open_access: true }, { title: 'Catalog only', origin: 'openlibrary', archive_url: 'https://archive.org/details/example' }, null] } };
    };
    const api = await load();
    const result = await api.searchExternalSource('libgen_mcp', 'Book', 30);
    expect(result.books).toHaveLength(2);
    expect(result.books[0]).toMatchObject({ source: 'libgen_mcp', origin: 'libgen', md5, extension: 'pdf', author: 'Author' });
    expect(result.discovery[0]).toMatchObject({ title: 'Catalog only', metadata_only: true });
    expect(closes).toBe(2);
  });

  test('nil Go catalog results still permit DOI/ISBN discovery', async () => {
    invoke = async () => reply({ results: null, open_access: [{ title: 'Licensed book', isbn: '978-0-306-40615-7', origin: 'openlibrary' }] });
    const { searchExternalSource } = await load();
    expect((await searchExternalSource('libgen_mcp', 'Book', 10)).books[0].isbn).toBe('978-0-306-40615-7');
  });

  test('find-a-book uses its LibGen tool and does not forward private environment', async () => {
    process.env.ZLIBRARY_EMAIL = 'secret@example.org'; process.env.ZLIBRARY_PASSWORD = 'private';
    process.env.ZLIBRARY_ACCOUNTS = '[private]'; process.env.ANNAS_SECRET_KEY = 'secret';
    process.env.LIBGEN_MCP_CORE_KEY = 'secret'; process.env.LIBGEN_MIRRORS = 'https://libgen.li';
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1234';
    invoke = async request => {
      expect(request.name).toBe('search_books');
      expect(config.env).not.toHaveProperty('ZLIBRARY_EMAIL');
      expect(config.env).not.toHaveProperty('ZLIBRARY_PASSWORD');
      expect(config.env).not.toHaveProperty('ZLIBRARY_ACCOUNTS');
      expect(config.env).not.toHaveProperty('ANNAS_SECRET_KEY');
      expect(config.env).not.toHaveProperty('LIBGEN_MCP_CORE_KEY');
      expect(config.env.LIBGEN_MIRRORS).toBe('https://libgen.li');
      expect(config.env.HTTPS_PROXY).toBe('http://127.0.0.1:1234');
      expect(config.env.HOME).toBe(config.cwd);
      expect(config.args).toHaveLength(1);
      expect(config.args[0]).not.toContain('--env-file');
      return reply({ books: [{ title: 'Book', md5 }, { title: 'Other', md5: 'b'.repeat(32) }] });
    };
    const { searchExternalSource } = await load();
    expect((await searchExternalSource('find_a_book', 'Book', 1)).books).toHaveLength(1);
  });

  test.each([{ isError: true, content: [{ type: 'text', text: 'private error' }] }, { content: [{ type: 'text', text: 'not JSON' }] }, reply({ error: 'private error' }), reply({ books: 'invalid' })])('upstream errors are sanitized and the child workspace is cleaned', async response => {
    invoke = async () => response;
    const { searchExternalSource } = await load();
    await expect(searchExternalSource('find_a_book', 'Book', 10)).rejects.toThrow('upstream request failed');
    expect(closes).toBe(2);
  });

  test('request cancellation closes the child and cleans its temporary workspace', async () => {
    const controller = new AbortController();
    invoke = async (_, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      controller.abort();
    });
    const { searchExternalSource } = await load();
    await expect(searchExternalSource('find_a_book', 'Book', 10, controller.signal)).rejects.toThrow('cancelled or timed out');
  });

  test('pre-cancelled requests do not start a process', async () => {
    const { searchExternalSource } = await load();
    await expect(searchExternalSource('libgen_mcp', 'Book', 10, AbortSignal.abort())).rejects.toThrow();
    expect(roots).toEqual([]);
  });
});

describe('External download staging, integrity and publication', () => {
  async function writeResult(source, contents = bytes) {
    const file = path.join(config.cwd, 'book.pdf');
    await fs.writeFile(file, contents);
    return reply({ [source === 'libgen_mcp' ? 'path' : 'file_path']: file, size_bytes: contents.length });
  }

  test.each(['libgen_mcp', 'find_a_book'])('%s validates the chosen MD5 and publishes without overwriting existing files', async source => {
    invoke = async request => {
      expect(request.name).toBe(source === 'libgen_mcp' ? 'download' : 'download_book');
      expect(request.arguments.md5).toBe(md5);
      expect(request.arguments.path || request.arguments.dest_dir).toBe(config.cwd);
      return writeResult(source);
    };
    await fs.writeFile(path.join(targetDir, 'existing.pdf'), 'keep');
    const { downloadExternalSource } = await load();
    const a = await downloadExternalSource({ source, md5, title: '../Book' }, targetDir);
    const b = await downloadExternalSource({ source, md5, title: '../Book' }, targetDir);
    expect(a.file_path).not.toBe(b.file_path);
    expect(path.dirname(a.file_path)).toBe(targetDir);
    expect(await fs.readFile(a.file_path)).toEqual(bytes);
    expect(await fs.readFile(path.join(targetDir, 'existing.pdf'), 'utf8')).toBe('keep');
    expect((await fs.readdir(targetDir)).some(name => name.startsWith('.bookharbor-'))).toBe(false);
  });

  test.each([{ doi: '10.1234/example' }, { isbn: '9780306406157' }])('libgen-mcp supports an open access identifier %p', async id => {
    invoke = async request => {
      expect(request.arguments).toMatchObject(id);
      return writeResult('libgen_mcp');
    };
    const { downloadExternalSource } = await load();
    const result = await downloadExternalSource({ source: 'libgen_mcp', title: 'OA book', ...id }, targetDir);
    expect(await fs.readFile(result.file_path)).toEqual(bytes);
  });

  test.each([{ source: 'find_a_book', md5: '../escape' }, { source: 'libgen_mcp', md5: 'abc' }, { source: 'libgen_mcp', doi: 'http://127.0.0.1' }, { source: '__proto__', md5 }])('invalid identifier/source %p is rejected before running a backend', async book => {
    const { downloadExternalSource } = await load();
    await expect(downloadExternalSource(book, targetDir)).rejects.toThrow();
    expect(roots).toEqual([]);
  });

  test.each(['outside', 'symlink', 'empty', 'html', 'md5', 'size', 'extension', 'missing'])('rejects %s output without publishing a file', async mode => {
    invoke = async () => {
      const file = path.join(config.cwd, mode === 'extension' ? 'book.exe' : 'book.pdf');
      await fs.writeFile(file, mode === 'empty' ? '' : mode === 'html' ? '<html>blocked</html>' : mode === 'md5' ? 'wrong book' : bytes);
      if (mode === 'outside') {
        const outside = path.join(targetDir, 'outside.pdf'); await fs.writeFile(outside, bytes);
        return reply({ file_path: outside });
      }
      if (mode === 'symlink') { const link = path.join(config.cwd, 'link.pdf'); await fs.symlink(file, link); return reply({ file_path: link }); }
      return reply(mode === 'missing' ? {} : { file_path: file, size_bytes: mode === 'size' ? bytes.length + 1 : (await fs.stat(file)).size });
    };
    const { downloadExternalSource } = await load();
    await expect(downloadExternalSource({ source: 'find_a_book', md5 }, targetDir)).rejects.toThrow('upstream request failed');
    expect((await fs.readdir(targetDir)).filter(name => name !== 'outside.pdf')).toEqual([]);
  });
});
