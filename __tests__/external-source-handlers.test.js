import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';

const savedEnv = { ...process.env };
let external, api, handlers, toolRegistry;
const book = { title: 'Book', source: 'find_a_book', origin: 'libgen', md5: 'a'.repeat(32) };
beforeEach(async () => {
  jest.resetModules();
  delete process.env.ZLIBRARY_EMAIL; delete process.env.ZLIBRARY_PASSWORD;
  delete process.env.ZLIBRARY_ACCOUNTS; delete process.env.ANNAS_SECRET_KEY;
  external = {
    enabledExternalSources: () => ['libgen_mcp', 'find_a_book'],
    isExternalSource: value => ['libgen_mcp', 'find_a_book'].includes(value),
    searchExternalSource: jest.fn().mockResolvedValue({ books: [book], discovery: [] }),
    downloadExternalSource: jest.fn().mockResolvedValue({ file_path: '/out/book.epub', processed_file_path: null }),
  };
  api = { searchMultiSource: jest.fn().mockResolvedValue({ books: [] }), downloadBookToFile: jest.fn(), processDocumentForRag: jest.fn() };
  jest.unstable_mockModule('../lib/external-sources.js', () => external);
  jest.unstable_mockModule('../lib/zlibrary-api.js', () => api);
  ({ handlers, toolRegistry } = await import('../dist/index.js'));
});
afterEach(() => { process.env = { ...savedEnv }; });

test.each(['libgen_mcp', 'find_a_book'])('explicit %s source routes to that backend with cancellation support', async source => {
  const signal = new AbortController().signal;
  const args = toolRegistry.search_multi_source.schema.parse({ query: 'Book', source });
  const result = await handlers.searchMultiSource(args, signal);
  expect(external.searchExternalSource).toHaveBeenCalledWith(source, 'Book', 10, signal);
  expect(result.books[0].recommendation.clarity).toBe('unverified');
  expect(api.searchMultiSource).not.toHaveBeenCalled();
});

test('all merges backend discovery, retains successful results, and isolates one failed backend', async () => {
  external.searchExternalSource.mockImplementation(async source => {
    if (source === 'libgen_mcp') throw new Error('unavailable');
    return { books: [book], discovery: [{ title: 'Catalog only', metadata_only: true }] };
  });
  const result = await handlers.searchMultiSource(toolRegistry.search_multi_source.schema.parse({ query: 'Book' }));
  expect(result.books).toHaveLength(1);
  expect(result.sources_unavailable).toEqual(['libgen_mcp']);
  expect(result.discovery[0].metadata_only).toBe(true);
});

test('external downloads cannot bypass the existing user confirmation gate', async () => {
  const result = await handlers.downloadBookToFile({ bookDetails: book });
  expect(result.status).toBe('confirmation_required');
  expect(external.downloadExternalSource).not.toHaveBeenCalled();
  expect(api.downloadBookToFile).not.toHaveBeenCalled();
});

test('approved external downloads use the backend and forward the cancellation signal', async () => {
  const signal = new AbortController().signal;
  const result = await handlers.downloadBookToFile({ bookDetails: book, outputDir: '/out', confirmed: true }, undefined, signal);
  expect(external.downloadExternalSource).toHaveBeenCalledWith(book, '/out', signal);
  expect(result.file_path).toBe('/out/book.epub');
  expect(api.downloadBookToFile).not.toHaveBeenCalled();
});

test('external downloads optionally reuse the RAG pipeline and preserve the original file path', async () => {
  api.processDocumentForRag.mockResolvedValue({ processed_file_path: '/out/text.md', metadata_file_path: '/out/text.json' });
  const result = await handlers.downloadBookToFile({ bookDetails: book, outputDir: '/out', confirmed: true, process_for_rag: true, processed_output_format: 'markdown' });
  expect(api.processDocumentForRag).toHaveBeenCalledWith({ filePath: '/out/book.epub', outputFormat: 'markdown' });
  expect(result).toMatchObject({ file_path: '/out/book.epub', processed_file_path: '/out/text.md', metadata_file_path: '/out/text.json' });
});

test('a failed backend download does not enter the Python download or RAG pipeline', async () => {
  external.downloadExternalSource.mockRejectedValue(new Error('backend unavailable'));
  const result = await handlers.downloadBookToFile({ bookDetails: book, outputDir: '/out', confirmed: true, process_for_rag: true });
  expect(result.error.message).toBe('backend unavailable');
  expect(api.downloadBookToFile).not.toHaveBeenCalled();
  expect(api.processDocumentForRag).not.toHaveBeenCalled();
});
