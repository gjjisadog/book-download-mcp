import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { rankBookCandidates, selectDownload } from '../dist/lib/book-selection.js';

const low = { id: 'low', title: 'Book', source: 'zlibrary', quality: '2', rating: '4.9' };
const clear = { id: 'clear', title: 'Book', source: 'zlibrary', quality: '4', rating: '4' };
const preferred = { id: 'preferred', title: 'Book', source: 'zlibrary', quality: '4', rating: '4.8' };
const unknown = { md5: 'a'.repeat(32), title: 'Book', source: 'libgen', size: '999 MB' };
const savedEnv = { ...process.env };
beforeEach(() => { process.env.BOOKHARBOR_MCP_SOURCES = ''; });
afterEach(() => { process.env = { ...savedEnv }; jest.restoreAllMocks(); });

describe('Version recommendations', () => {
  test('quality comes first, rating breaks ties; file size is not a quality signal', () => {
    const input = [unknown, low, clear, preferred];
    const ranked = rankBookCandidates(input);
    expect(ranked.map(b => b.id || b.md5)).toEqual(['preferred', 'clear', 'low', unknown.md5]);
    expect(ranked[0].recommendation.reported_quality.value).toBe(4);
    expect(ranked[0].recommendation.clarity).toBe('unverified');
    expect(input[0]).not.toHaveProperty('recommendation');
    expect(ranked[3].recommendation.reported_rating).toBeNull();
  });

  test('different declared scales are normalized before comparing', () => {
    const ranked = rankBookCandidates([
      { id: 'a', source: 'one', quality_score: 8, quality_max: 10 },
      { id: 'b', source: 'two', quality_score: 0.9, quality_max: 1 },
    ]);
    expect(ranked[0].id).toBe('b');
  });

  test('ratings with declared scales are compared and review metadata is preserved', () => {
    const ranked = rankBookCandidates([
      { id: 'a', source: 'one', rating: { value: 8, max: 10, count: 100 } },
      { id: 'b', source: 'two', rating: { value: 4.5, max: 5, count: 20 } },
    ]);
    expect(ranked[0].id).toBe('b');
    expect(ranked[0].rating.count).toBe(20);
  });

  test('incompatible unknown scales keep source order instead of inventing a comparison', () => {
    const ranked = rankBookCandidates([
      { id: 'a', source: 'one', quality: 0.9 },
      { id: 'b', source: 'two', quality: 8 },
    ]);
    expect(ranked.map(b => b.id)).toEqual(['a', 'b']);
    expect(ranked[0].recommendation.reasons[0]).toContain('incomparable');
  });

  test.each([undefined, null, '', 'N/A', true, {}, -1, Infinity, '4 stars'])('invalid/missing score %p stays unknown', value => {
    const result = rankBookCandidates([{ quality: value, rating: value }])[0];
    expect(result.recommendation.reported_quality).toBeNull();
    expect(result.recommendation.reported_rating).toBeNull();
  });

  test('out of range scores are discarded and unknown ties stay stable', () => {
    const result = rankBookCandidates([{ id: 'a', quality: 6, quality_max: 5 }, { id: 'b' }]);
    expect(result.map(b => b.id)).toEqual(['a', 'b']);
    expect(result[0].recommendation.reported_quality).toBeNull();
  });
});

describe('Confirmation and cancellation', () => {
  const args = { bookDetails: low, alternatives: [preferred, unknown], outputDir: '/downloads', process_for_rag: true };
  const server = (response, capabilities = { elicitation: { form: {} } }) => ({
    getClientCapabilities: () => capabilities,
    elicitInput: jest.fn().mockResolvedValue(response),
  });

  test('no form support returns candidates without downloading', async () => {
    for (const capabilities of [undefined, {}, { elicitation: { url: {} } }]) {
      const mock = server({}, capabilities);
      if (capabilities === undefined) mock.getClientCapabilities = () => undefined;
      const result = await selectDownload(args, mock);
      expect(result.status).toBe('confirmation_required');
      expect(result.candidates[0].id).toBe('preferred');
      expect(result.book).toBeUndefined();
      expect(mock.elicitInput).not.toHaveBeenCalled();
    }
  });

  test('user can choose a lower ranked version; dialog shows evidence and destination', async () => {
    const mock = server({ action: 'accept', content: { version: '1' } });
    const signal = new AbortController().signal;
    const result = await selectDownload(args, mock, signal);
    expect(result.book.id).toBe('low');
    const [request, options] = mock.elicitInput.mock.calls[0];
    expect(request.requestedSchema.properties.version.enum).toEqual(['0', '1', '2']);
    expect(request.requestedSchema.properties.version.enumNames[0]).toContain('4.8');
    expect(request.requestedSchema.properties.version.enumNames[2]).toContain('未知');
    expect(request.message).toContain('/downloads');
    expect(request.message).toContain('RAG');
    expect(options.signal).toBe(signal);
  });

  test.each(['decline', 'cancel'])('%s never selects a download', async action => {
    const result = await selectDownload(args, server({ action }));
    expect(result.status).toBe('cancelled');
    expect(result.book).toBeUndefined();
  });

  test.each([undefined, 0, '-1', '01', '3', '__proto__'])('invalid choice %p never selects a download', async version => {
    await expect(selectDownload(args, server({ action: 'accept', content: { version } }))).rejects.toThrow('No valid book version');
  });

  test('prior explicit confirmation keeps the exact selected book, without silently switching', async () => {
    const mock = server({ action: 'cancel' });
    expect((await selectDownload({ ...args, confirmed: true }, mock)).book).toBe(low);
    expect(mock.elicitInput).not.toHaveBeenCalled();
  });

  test('single book without prior confirmation still needs user consent', async () => {
    expect((await selectDownload({ bookDetails: unknown })).status).toBe('confirmation_required');
  });
});

describe('Search and download handler integration', () => {
  async function setup() {
    jest.resetModules();
    const api = { searchBooks: jest.fn(), searchMultiSource: jest.fn(), downloadBookToFile: jest.fn() };
    jest.unstable_mockModule('../lib/zlibrary-api.js', () => api);
    const { handlers, toolRegistry } = await import('../dist/index.js');
    return { api, handlers, toolRegistry };
  }

  test('default all searches configured sources concurrently, ranks and limits combined results', async () => {
    process.env.ZLIBRARY_EMAIL = 'test@example.org'; process.env.ZLIBRARY_PASSWORD = 'test';
    process.env.ANNAS_SECRET_KEY = 'test';
    const { api, handlers, toolRegistry } = await setup();
    api.searchBooks.mockResolvedValue({ books: [low, preferred] });
    api.searchMultiSource.mockImplementation(async ({ source }) => ({ books: [{ ...unknown, source }] }));
    const result = await handlers.searchMultiSource(toolRegistry.search_multi_source.schema.parse({ query: 'Book', count: 2 }));
    expect(api.searchBooks).toHaveBeenCalledWith({ query: 'Book', count: 2 });
    expect(api.searchMultiSource).toHaveBeenCalledTimes(2);
    expect(result.books.map(b => b.id)).toEqual(['preferred', 'low']);
    expect(result.sources_used).toEqual(['zlibrary', 'annas', 'libgen']);
  });

  test('unconfigured sources are skipped and one failed source does not hide healthy results', async () => {
    delete process.env.ANNAS_SECRET_KEY; delete process.env.ZLIBRARY_ACCOUNTS;
    process.env.ZLIBRARY_EMAIL = 'test@example.org'; process.env.ZLIBRARY_PASSWORD = 'test';
    const { api, handlers } = await setup();
    api.searchBooks.mockRejectedValue(new Error('private failure details'));
    api.searchMultiSource.mockResolvedValue({ books: [unknown] });
    const result = await handlers.searchMultiSource({ query: 'Book', source: 'all', count: 10 });
    expect(result.books).toHaveLength(1);
    expect(result.sources_unavailable).toEqual(['zlibrary']);
    expect(JSON.stringify(result)).not.toContain('private failure');
  });

  test('all failures report an error; successful empty results remain empty', async () => {
    delete process.env.ANNAS_SECRET_KEY; delete process.env.ZLIBRARY_ACCOUNTS;
    delete process.env.ZLIBRARY_EMAIL; delete process.env.ZLIBRARY_PASSWORD;
    const { api, handlers } = await setup();
    api.searchMultiSource.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ books: [] });
    expect(await handlers.searchMultiSource({ query: 'Book', source: 'all', count: 10 })).toHaveProperty('error');
    expect((await handlers.searchMultiSource({ query: 'Book', source: 'all', count: 10 })).books).toEqual([]);
  });

  test('explicit Z-Library selection does not query other sources', async () => {
    const { api, handlers } = await setup();
    api.searchBooks.mockResolvedValue({ books: [{ ...preferred, source: undefined }] });
    const result = await handlers.searchMultiSource({ query: 'Book', source: 'zlibrary', count: 10 });
    expect(result.books[0].source).toBe('zlibrary');
    expect(api.searchMultiSource).not.toHaveBeenCalled();
  });

  test('fallback duplicates are removed and actual origins are reported', async () => {
    delete process.env.ZLIBRARY_EMAIL; delete process.env.ZLIBRARY_PASSWORD; delete process.env.ZLIBRARY_ACCOUNTS;
    process.env.ANNAS_SECRET_KEY = 'test';
    const { api, handlers } = await setup();
    api.searchMultiSource.mockResolvedValue({ books: [unknown] });
    const result = await handlers.searchMultiSource({ query: 'Book', source: 'all', count: 10 });
    expect(result.books).toHaveLength(1);
    expect(result.sources_used).toEqual(['libgen']);
  });

  test('neither unsupported clients nor cancellation can reach the download API', async () => {
    const { api, handlers } = await setup();
    const args = { bookDetails: low, alternatives: [preferred] };
    expect((await handlers.downloadBookToFile(args)).status).toBe('confirmation_required');
    const server = { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: async () => ({ action: 'cancel' }) };
    expect((await handlers.downloadBookToFile(args, server)).status).toBe('cancelled');
    expect(api.downloadBookToFile).not.toHaveBeenCalled();
  });

  test('accepted choice alone reaches download; dialog failure cannot start a download', async () => {
    const { api, handlers } = await setup();
    api.downloadBookToFile.mockResolvedValue({ file_path: '/downloads/book.epub' });
    const server = { getClientCapabilities: () => ({ elicitation: { form: {} } }), elicitInput: jest.fn().mockResolvedValueOnce({ action: 'accept', content: { version: '0' } }).mockRejectedValueOnce(new Error('dialog closed')) };
    const args = { bookDetails: low, alternatives: [preferred] };
    await handlers.downloadBookToFile(args, server);
    expect(api.downloadBookToFile.mock.calls[0][0].bookDetails.id).toBe('preferred');
    expect(await handlers.downloadBookToFile(args, server)).toHaveProperty('error');
    expect(api.downloadBookToFile).toHaveBeenCalledTimes(1);
  });
});

test('real MCP protocol negotiates form support and validates a selected version', async () => {
  const [st, ct] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'selection-test', version: '1' }, { capabilities: { tools: {} } });
  const client = new Client({ name: 'form-client', version: '1' }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async request => {
    expect(request.params.requestedSchema.properties.version.enumNames[0]).toContain('优先推荐');
    return { action: 'accept', content: { version: '1' } };
  });
  server.setRequestHandler(CallToolRequestSchema, async (_, extra) => {
    const selection = await selectDownload({ bookDetails: low, alternatives: [preferred] }, server, extra.signal);
    return { content: [{ type: 'text', text: JSON.stringify(selection) }] };
  });
  try {
    await Promise.all([server.connect(st), client.connect(ct)]);
    const result = await client.callTool({ name: 'select', arguments: {} });
    expect(JSON.parse(result.content[0].text).book.id).toBe('low');
  } finally { await client.close(); await server.close(); }
});
