#!/usr/bin/env node
import { withPythonRequest } from './lib/bridge-runner.js';

import type { ZodObject, ZodRawShape } from 'zod';
import { z } from 'zod';
// UV Migration Note: ensureVenvReady removed - user runs `uv sync` before build
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Import SDK components using ESM syntax
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

// Import API handlers
import * as zlibraryApi from './lib/zlibrary-api.js';
import { logger } from './lib/logger.js';
import { rankBookCandidates, selectDownload } from './lib/book-selection.js';
import {
  enabledExternalSources,
  isExternalSource,
  searchExternalSource,
  downloadExternalSource,
} from './lib/external-sources.js';

// Recreate __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define Zod schemas for tool parameters
const SearchBooksParamsSchema = z.object({
  query: z.string().describe('Search query'),
  exact: z.boolean().optional().default(false).describe('Whether to perform an exact match search'),
  fromYear: z.number().int().optional().describe('Filter by minimum publication year'),
  toYear: z.number().int().optional().describe('Filter by maximum publication year'),
  languages: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Filter by languages (e.g., ["english", "russian"])'),
  extensions: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Filter by file extensions (e.g., ["pdf", "epub"])'),
  content_types: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Filter by content types (e.g., ["book", "article"])'),
  count: z.number().int().optional().default(10).describe('Number of results to return per page'),
});

const FullTextSearchParamsSchema = z.object({
  query: z.string().describe('Text to search for in book content'),
  exact: z.boolean().optional().default(false).describe('Whether to perform an exact match search'),
  phrase: z
    .boolean()
    .optional()
    .default(true)
    .describe('Whether to search for the exact phrase (requires at least 2 words)'),
  words: z.boolean().optional().default(false).describe('Whether to search for individual words'),
  languages: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Filter by languages (e.g., ["english", "russian"])'),
  extensions: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Filter by file extensions (e.g., ["pdf", "epub"])'),
  content_types: z
    .array(z.string())
    .optional()
    .default([])
    .describe('Filter by content types (e.g., ["book", "article"])'),
  count: z.number().int().optional().default(10).describe('Number of results to return per page'),
});

const GetDownloadHistoryParamsSchema = z.object({
  count: z.number().int().optional().default(10).describe('Number of results to return'),
});

const GetDownloadLimitsParamsSchema = z.object({});

const GetRecentBooksParamsSchema = z.object({
  count: z.number().int().optional().default(10).describe('Number of books to return'),
  format: z.string().optional().describe('Filter by file format (e.g., "pdf", "epub")'),
});

const DownloadBookToFileParamsSchema = z.object({
  bookDetails: z
    .object({})
    .loose()
    .describe('The full selected book object from search_books or search_multi_source'),
  alternatives: z
    .array(z.object({}).loose())
    .max(19)
    .optional()
    .describe(
      'Other matching versions to compare and show in the confirmation dialog (up to 19). Include available alternatives from multi-source search.',
    ),
  confirmed: z
    .boolean()
    .optional()
    .describe(
      'Set true only after the user explicitly confirmed this exact bookDetails in conversation. Otherwise request an interactive version selection before downloading.',
    ),
  outputDir: z
    .string()
    .optional()
    .default('./downloads')
    .describe('Directory to save the file to (default: "./downloads")'),
  process_for_rag: z
    .boolean()
    .optional()
    .describe('Whether to process the document content for RAG after download'),
  processed_output_format: z
    .string()
    .optional()
    .describe('Desired output format for RAG processing (e.g., "text", "markdown")'),
});

const ProcessDocumentForRagParamsSchema = z.object({
  file_path: z.string().describe('Path to the downloaded file to process'),
  output_format: z.string().optional().describe('Desired output format (e.g., "text", "markdown")'),
});

const GetBookMetadataParamsSchema = z.object({
  bookId: z.string().describe('Z-Library book ID'),
  bookHash: z.string().describe('Book hash (can be extracted from book URL)'),
  include: z
    .array(z.enum(['terms', 'booklists', 'ipfs', 'ratings', 'description']))
    .optional()
    .describe(
      'Optional field groups to include beyond core defaults. Core always includes: title, author, year, publisher, language, pages, isbn, rating, cover, categories, extension, filesize. Use include to add: terms (conceptual keywords), booklists (curated collections), ipfs (IPFS CIDs), ratings (quality_score), description (full text description).',
    ),
});

const SearchByTermParamsSchema = z.object({
  term: z.string().describe('Conceptual term to search for (e.g., "dialectic", "phenomenology")'),
  yearFrom: z.number().int().optional().describe('Filter by minimum publication year'),
  yearTo: z.number().int().optional().describe('Filter by maximum publication year'),
  languages: z.array(z.string()).optional().default([]).describe('Filter by languages'),
  extensions: z.array(z.string()).optional().default([]).describe('Filter by file extensions'),
  count: z.number().int().optional().default(25).describe('Number of results to return'),
});

const SearchByAuthorParamsSchema = z.object({
  author: z.string().describe('Author name (supports "Lastname, Firstname" format)'),
  exact: z.boolean().optional().default(false).describe('Use exact author name matching'),
  yearFrom: z.number().int().optional().describe('Filter by minimum publication year'),
  yearTo: z.number().int().optional().describe('Filter by maximum publication year'),
  languages: z.array(z.string()).optional().default([]).describe('Filter by languages'),
  extensions: z.array(z.string()).optional().default([]).describe('Filter by file extensions'),
  count: z.number().int().optional().default(25).describe('Number of results to return'),
});

const FetchBooklistParamsSchema = z.object({
  booklistId: z.string().describe('Booklist ID from book metadata'),
  booklistHash: z.string().describe('Booklist hash from book metadata'),
  topic: z.string().describe('Booklist topic name'),
  page: z.number().int().optional().default(1).describe('Page number for pagination'),
});

const SearchAdvancedParamsSchema = z.object({
  query: z.string().describe('Search query'),
  exact: z.boolean().optional().default(false).describe('Whether to perform exact match search'),
  yearFrom: z.number().int().optional().describe('Filter by minimum publication year'),
  yearTo: z.number().int().optional().describe('Filter by maximum publication year'),
  count: z.number().int().optional().default(10).describe('Number of results to return'),
});

const SearchMultiSourceParamsSchema = z.object({
  query: z.string().describe('Search query'),
  source: z
    .enum(['all', 'auto', 'zlibrary', 'annas', 'libgen', 'libgen_mcp', 'find_a_book'])
    .optional()
    .default('all')
    .describe(
      "all (default): compare all configured sources/backends in parallel; auto: Anna's Archive with LibGen fallback; or force zlibrary, annas, libgen, libgen_mcp (@jmrp.io/libgen-mcp), find_a_book (find-a-book-mcp)",
    ),
  count: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Maximum number of ranked results to return'),
});

// ============================================================================
// Tool Annotations (MCP Best Practice - helps AI assistants make better decisions)
// ============================================================================

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  title?: string;
}

const toolAnnotations: Record<string, ToolAnnotations> = {
  search_books: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    title: 'Search Books',
  },
  full_text_search: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    title: 'Full Text Search',
  },
  get_download_history: {
    readOnlyHint: true,
    idempotentHint: false,
    openWorldHint: true,
    title: 'Download History',
  },
  get_download_limits: {
    readOnlyHint: true,
    idempotentHint: false,
    openWorldHint: true,
    title: 'Download Limits',
  },
  download_book_to_file: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
    title: 'Download Book',
  },
  process_document_for_rag: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    title: 'Process for RAG',
  },
  get_book_metadata: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    title: 'Book Metadata',
  },
  search_by_term: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    title: 'Search by Term',
  },
  search_by_author: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    title: 'Search by Author',
  },
  fetch_booklist: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    title: 'Fetch Booklist',
  },
  search_advanced: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    title: 'Advanced Search',
  },
  search_multi_source: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
    title: 'Multi-Source Search',
  },
};

// ============================================================================
// Tool handler implementations
// ============================================================================

interface HandlerMap {
  [key: string]: (args: any) => Promise<any>;
  searchBooks: (args: any) => Promise<any>;
  fullTextSearch: (args: any) => Promise<any>;
  getDownloadHistory: (args: any) => Promise<any>;
  getDownloadLimits: (args: any) => Promise<any>;
  downloadBookToFile: (args: any, server?: Server, signal?: AbortSignal) => Promise<any>;
  processDocumentForRag: (args: any) => Promise<any>;
  getBookMetadata: (args: any) => Promise<any>;
  searchByTerm: (args: any) => Promise<any>;
  searchByAuthor: (args: any) => Promise<any>;
  fetchBooklist: (args: any) => Promise<any>;
  searchAdvanced: (args: any) => Promise<any>;
  searchMultiSource: (args: any, signal?: AbortSignal) => Promise<any>;
}

const handlers: HandlerMap = {
  searchBooks: async (args: z.infer<typeof SearchBooksParamsSchema>) => {
    try {
      const searchBooksReceivedArgsLog = `[${new Date().toISOString()}] [src/index.ts] searchBooks handler received Zod-parsed args: ${JSON.stringify(args)}\n`;
      logger.debug(searchBooksReceivedArgsLog.trim());
      const apiArgs = {
        query: args.query,
        exact: args.exact,
        fromYear: args.fromYear,
        toYear: args.toYear,
        languages: args.languages,
        extensions: args.extensions,
        content_types: args.content_types,
        count: args.count,
      };
      const searchBooksSendingLog = `[${new Date().toISOString()}] [src/index.ts] searchBooks handler sending to zlibraryApi: ${JSON.stringify(apiArgs)}\n`;
      logger.debug(searchBooksSendingLog.trim());
      return await zlibraryApi.searchBooks(apiArgs);
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to search books' } };
    }
  },

  fullTextSearch: async (args: z.infer<typeof FullTextSearchParamsSchema>) => {
    try {
      const ftsReceivedArgsLog = `[${new Date().toISOString()}] [src/index.ts] fullTextSearch handler received Zod-parsed args: ${JSON.stringify(args)}\n`;
      logger.debug(ftsReceivedArgsLog.trim());
      const apiArgsFTS = {
        query: args.query,
        exact: args.exact,
        phrase: args.phrase,
        words: args.words,
        languages: args.languages,
        extensions: args.extensions,
        content_types: args.content_types,
        count: args.count,
      };
      const ftsSendingLog = `[${new Date().toISOString()}] [src/index.ts] fullTextSearch handler sending to zlibraryApi: ${JSON.stringify(apiArgsFTS)}\n`;
      logger.debug(ftsSendingLog.trim());
      return await zlibraryApi.fullTextSearch(apiArgsFTS);
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to perform full text search' } };
    }
  },

  getDownloadHistory: async (args: z.infer<typeof GetDownloadHistoryParamsSchema>) => {
    try {
      return await zlibraryApi.getDownloadHistory(args);
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to get download history' } };
    }
  },

  getDownloadLimits: async () => {
    try {
      return await zlibraryApi.getDownloadLimits();
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to get download limits' } };
    }
  },

  downloadBookToFile: async (
    args: z.infer<typeof DownloadBookToFileParamsSchema>,
    server?: Server,
    signal?: AbortSignal,
  ) => {
    try {
      const selection = await selectDownload(args, server, signal);
      if (!selection.book) return selection;
      if (isExternalSource(selection.book.source)) {
        const result = await downloadExternalSource(selection.book, args.outputDir, signal);
        if (!args.process_for_rag) return result;
        const processed = await zlibraryApi.processDocumentForRag({
          filePath: result.file_path,
          outputFormat: args.processed_output_format,
        });
        return { ...result, ...processed, file_path: result.file_path };
      }
      return await zlibraryApi.downloadBookToFile({ ...args, bookDetails: selection.book });
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to download book' } };
    }
  },

  processDocumentForRag: async (args: z.infer<typeof ProcessDocumentForRagParamsSchema>) => {
    try {
      return await zlibraryApi.processDocumentForRag({
        filePath: args.file_path,
        outputFormat: args.output_format,
      });
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to process document for RAG' } };
    }
  },

  getBookMetadata: async (args: z.infer<typeof GetBookMetadataParamsSchema>) => {
    try {
      return await zlibraryApi.getBookMetadata(args.bookId, args.bookHash, args.include);
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to get book metadata' } };
    }
  },

  searchByTerm: async (args: z.infer<typeof SearchByTermParamsSchema>) => {
    try {
      return await zlibraryApi.searchByTerm({
        term: args.term,
        yearFrom: args.yearFrom,
        yearTo: args.yearTo,
        languages: args.languages,
        extensions: args.extensions,
        limit: args.count,
      });
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to search by term' } };
    }
  },

  searchByAuthor: async (args: z.infer<typeof SearchByAuthorParamsSchema>) => {
    try {
      return await zlibraryApi.searchByAuthor({
        author: args.author,
        exact: args.exact,
        yearFrom: args.yearFrom,
        yearTo: args.yearTo,
        languages: args.languages,
        extensions: args.extensions,
        limit: args.count,
      });
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to search by author' } };
    }
  },

  fetchBooklist: async (args: z.infer<typeof FetchBooklistParamsSchema>) => {
    try {
      return await zlibraryApi.fetchBooklist({
        booklistId: args.booklistId,
        booklistHash: args.booklistHash,
        topic: args.topic,
        page: args.page,
      });
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to fetch booklist' } };
    }
  },

  searchAdvanced: async (args: z.infer<typeof SearchAdvancedParamsSchema>) => {
    try {
      return await zlibraryApi.searchAdvanced({
        query: args.query,
        exact: args.exact,
        yearFrom: args.yearFrom,
        yearTo: args.yearTo,
        count: args.count,
      });
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to perform advanced search' } };
    }
  },

  searchMultiSource: async (
    args: z.infer<typeof SearchMultiSourceParamsSchema>,
    signal?: AbortSignal,
  ) => {
    try {
      if (isExternalSource(args.source)) {
        const result = await searchExternalSource(args.source, args.query, args.count, signal);
        return { ...result, books: rankBookCandidates(result.books), sources_used: [args.source] };
      }
      if (args.source !== 'all' && args.source !== 'zlibrary') {
        const result = await zlibraryApi.searchMultiSource({ ...args, source: args.source });
        return Array.isArray(result?.books)
          ? { ...result, books: rankBookCandidates(result.books) }
          : result;
      }
      const sources: { name: string; run: () => Promise<any> }[] = [];
      if (
        args.source === 'zlibrary' ||
        process.env.ZLIBRARY_ACCOUNTS ||
        (process.env.ZLIBRARY_EMAIL && process.env.ZLIBRARY_PASSWORD)
      )
        sources.push({
          name: 'zlibrary',
          run: () => zlibraryApi.searchBooks({ query: args.query, count: args.count }),
        });
      if (args.source === 'all') {
        if (process.env.ANNAS_SECRET_KEY)
          sources.push({
            name: 'annas',
            run: () => zlibraryApi.searchMultiSource({ ...args, source: 'annas' }),
          });
        sources.push({
          name: 'libgen',
          run: () => zlibraryApi.searchMultiSource({ ...args, source: 'libgen' }),
        });
        for (const source of enabledExternalSources())
          sources.push({
            name: source,
            run: () => searchExternalSource(source, args.query, args.count, signal),
          });
      }
      const results = await Promise.allSettled(sources.map((source) => source.run()));
      const books: Record<string, any>[] = [];
      const discovery: Record<string, any>[] = [];
      const unavailable: string[] = [];
      results.forEach((result, index) => {
        const name = sources[index]!.name;
        if (result.status === 'rejected' || !Array.isArray(result.value?.books)) {
          unavailable.push(name);
          return;
        }
        books.push(
          ...result.value.books.map((book: Record<string, any>) => ({
            ...book,
            source: book.source || name,
          })),
        );
        if (Array.isArray(result.value.discovery)) discovery.push(...result.value.discovery);
      });
      if (unavailable.length === sources.length)
        throw new Error('All configured book sources failed');
      // A provider's fallback can return the same LibGen hit as the direct search.
      const seen = new Set<string>();
      const uniqueBooks = books.filter((book) => {
        const id = book.md5 || book.id;
        if (!id) return true;
        const key = `${book.source}:${id}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        books: rankBookCandidates(uniqueBooks).slice(0, args.count),
        sources_used: [...new Set(books.map((book) => book.source))],
        sources_unavailable: unavailable,
        discovery,
        selection_note:
          'Reported quality first, reader rating second; actual clarity is unverified. Review title, author, language and edition. Pass matching alternatives to download_book_to_file for user confirmation.',
      };
    } catch (error: any) {
      return { error: { message: error.message || 'Failed to search multi-source' } };
    }
  },
};

// ============================================================================
// Legacy compatibility exports (used by existing tests - will be updated in 03-02)
// ============================================================================

interface ToolRegistryEntry {
  description: string;
  schema: ZodObject<ZodRawShape>;
  handler?: (args: any) => Promise<any>;
}

const toolRegistry: Record<string, ToolRegistryEntry> = {
  search_books: {
    description: 'Search for books in Z-Library',
    schema: SearchBooksParamsSchema,
    handler: handlers.searchBooks,
  },
  full_text_search: {
    description: 'Full text search in book content',
    schema: FullTextSearchParamsSchema,
    handler: handlers.fullTextSearch,
  },
  get_download_history: {
    description: 'Get download history',
    schema: GetDownloadHistoryParamsSchema,
    handler: handlers.getDownloadHistory,
  },
  get_download_limits: {
    description: 'Get download limits',
    schema: GetDownloadLimitsParamsSchema,
    handler: handlers.getDownloadLimits,
  },
  get_recent_books: { description: 'Get recently added books', schema: GetRecentBooksParamsSchema },
  download_book_to_file: {
    description:
      'Compare matching versions and request user confirmation before downloading. Pass alternatives from multi-source search. Unsupported clients receive confirmation_required; ask the user before setting confirmed=true. Optionally produce a RAG bundle.',
    schema: DownloadBookToFileParamsSchema,
    handler: handlers.downloadBookToFile,
  },
  process_document_for_rag: {
    description:
      'Process EPUB, PDF, or TXT into a file-based RAG bundle with processed body text, metadata, and optional footnotes/endnotes/citations.',
    schema: ProcessDocumentForRagParamsSchema,
    handler: handlers.processDocumentForRag,
  },
  get_book_metadata: {
    description: 'Get book metadata',
    schema: GetBookMetadataParamsSchema,
    handler: handlers.getBookMetadata,
  },
  search_by_term: {
    description: 'Search by conceptual term',
    schema: SearchByTermParamsSchema,
    handler: handlers.searchByTerm,
  },
  search_by_author: {
    description: 'Search by author',
    schema: SearchByAuthorParamsSchema,
    handler: handlers.searchByAuthor,
  },
  fetch_booklist: {
    description: 'Fetch booklist',
    schema: FetchBooklistParamsSchema,
    handler: handlers.fetchBooklist,
  },
  search_advanced: {
    description: 'Advanced search',
    schema: SearchAdvancedParamsSchema,
    handler: handlers.searchAdvanced,
  },
  search_multi_source: {
    description: 'Multi-source search',
    schema: SearchMultiSourceParamsSchema,
    handler: handlers.searchMultiSource,
  },
};

// ============================================================================
// Helper functions
// ============================================================================

function getPackageVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version || 'unknown';
  } catch (error: any) {
    console.warn('Could not read package.json for version:', error.message);
    return 'unknown';
  }
}

// Helper to wrap handler results in MCP content format
function wrapResult(result: any, toolName: string) {
  if (result && typeof result === 'object' && 'error' in result && result.error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error from tool "${toolName}": ${result.error.message || result.error}`,
        },
      ],
      isError: true as const,
    };
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

// ============================================================================
// Server setup
// ============================================================================

/**
 * Check Z-Library credentials before server startup.
 *
 * Missing credentials are a warning, not a fatal error: since v1.4.0 the
 * LibGen source needs none, so `search_multi_source` and downloads of its
 * results work on a bare install. Exiting here would make a working,
 * unlimited source unreachable because an unrelated one was unconfigured.
 * Z-Library tools still fail with their own clear error when invoked.
 */
function validateCredentials(): void {
  const pool = process.env.ZLIBRARY_ACCOUNTS?.trim();
  if (pool) {
    let accounts: unknown;
    try {
      accounts = JSON.parse(pool);
    } catch {
      throw new Error('ZLIBRARY_ACCOUNTS must be a JSON array of accounts');
    }
    const parsed = z
      .array(
        z.object({
          email: z.string().trim().min(1),
          password: z.string().min(1),
        }),
      )
      .min(1)
      .safeParse(accounts);
    if (!parsed.success) {
      throw new Error('ZLIBRARY_ACCOUNTS requires a non-empty array of email/password strings');
    }
    const emails = parsed.data.map((account) => account.email.toLowerCase());
    if (new Set(emails).size !== emails.length) {
      throw new Error('ZLIBRARY_ACCOUNTS contains duplicate account emails');
    }
    return;
  }
  const email = process.env.ZLIBRARY_EMAIL;
  const password = process.env.ZLIBRARY_PASSWORD;

  if (!email || !password) {
    const missing: string[] = [];
    if (!email) missing.push('ZLIBRARY_EMAIL');
    if (!password) missing.push('ZLIBRARY_PASSWORD');

    logger.warn(
      `Missing environment variable(s): ${missing.join(', ')} — ` +
        `Z-Library tools (search_books, full_text_search, get_download_limits, ` +
        `download history) will fail when called. LibGen is unaffected: use ` +
        `search_multi_source with source="libgen" and pass results to ` +
        `download_book_to_file. To enable Z-Library, set "env": ` +
        `{"ZLIBRARY_EMAIL": "...", "ZLIBRARY_PASSWORD": "..."} or ` +
        `ZLIBRARY_ACCOUNTS in your MCP client configuration. See README.md.`,
    );
  }
}

interface StartOptions {
  testing?: boolean;
}

async function start(
  opts: StartOptions = {},
): Promise<{ server: McpServer; transport: StdioServerTransport } | null> {
  try {
    // Validate credentials before anything else (skip in test mode)
    if (!opts.testing) {
      validateCredentials();
    }

    // Instantiate the McpServer
    const server = new McpServer({
      name: 'zlibrary-mcp',
      version: getPackageVersion(),
    });

    // ========================================================================
    const registerTool: typeof server.tool = ((...args: any[]) => {
      const handler = args.pop();
      return (server.tool as any)(...args, (params: any, extra: any) =>
        withPythonRequest(extra?.signal, () => handler(params, extra)),
      );
    }) as typeof server.tool;

    // Register all 13 tools via server.tool()
    // ========================================================================

    // Helper to get annotations with proper typing
    const ann = (name: string) => toolAnnotations[name] as ToolAnnotations;

    // 1. search_books
    registerTool(
      'search_books',
      'Search for books in Z-Library by title, author, or keywords. Returns matching books with metadata including title (string), author (string), name, authors (array), year, format, and file size. Use exact=true for precise title matching. Filter results by year range, language, or file format.',
      SearchBooksParamsSchema.shape,
      ann('search_books'),
      async (args) => wrapResult(await handlers.searchBooks(args as any), 'search_books'),
    );

    // 2. full_text_search
    registerTool(
      'full_text_search',
      'Search for books containing specific text within their content. Returns books with title (string), author (string), name, authors (array), and other metadata. Useful for finding books that discuss particular topics, quotes, or concepts.',
      FullTextSearchParamsSchema.shape,
      ann('full_text_search'),
      async (args) => wrapResult(await handlers.fullTextSearch(args as any), 'full_text_search'),
    );

    // 3. get_download_history
    registerTool(
      'get_download_history',
      "Get the user's Z-Library download history. Returns a list of previously downloaded books with their metadata.",
      GetDownloadHistoryParamsSchema.shape,
      ann('get_download_history'),
      async (args) =>
        wrapResult(await handlers.getDownloadHistory(args as any), 'get_download_history'),
    );

    // 4. get_download_limits
    registerTool(
      'get_download_limits',
      "Get the user's current Z-Library download limits. Shows daily download quota, downloads used today, and remaining downloads.",
      GetDownloadLimitsParamsSchema.shape,
      ann('get_download_limits'),
      async (_args) => wrapResult(await handlers.getDownloadLimits(_args), 'get_download_limits'),
    );

    // 5. get_recent_books
    registerTool(
      'get_recent_books',
      'Get recently added books to Z-Library. Optionally filter by file format.',
      GetRecentBooksParamsSchema.shape,
      ann('search_books'),
      async (args) => {
        try {
          const result = await (zlibraryApi as any).getRecentBooks(args);
          return wrapResult(result, 'get_recent_books');
        } catch (error: any) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
            isError: true,
          };
        }
      },
    );

    // 6. download_book_to_file
    registerTool(
      'download_book_to_file',
      toolRegistry.download_book_to_file!.description,
      DownloadBookToFileParamsSchema.shape,
      ann('download_book_to_file'),
      async (args, extra) =>
        wrapResult(
          await handlers.downloadBookToFile(args as any, server.server, extra.signal),
          'download_book_to_file',
        ),
    );

    // 7. process_document_for_rag
    registerTool(
      'process_document_for_rag',
      'Process a downloaded document (EPUB, TXT, PDF) to extract clean text content for RAG (Retrieval-Augmented Generation). Extracts text, preserves structure, detects footnotes, and outputs a text file.',
      ProcessDocumentForRagParamsSchema.shape,
      ann('process_document_for_rag'),
      async (args) =>
        wrapResult(await handlers.processDocumentForRag(args as any), 'process_document_for_rag'),
    );

    // 8. get_book_metadata
    registerTool(
      'get_book_metadata',
      'Get metadata for a book. By default returns core fields (title, author, year, publisher, language, pages, isbn, rating, cover, categories). Use the include parameter to add optional field groups: terms (60+ conceptual keywords), booklists (11+ curated collections), ipfs (IPFS CIDs), ratings (quality score), description (full text). Requires bookId and bookHash from search results.',
      GetBookMetadataParamsSchema.shape,
      ann('get_book_metadata'),
      async (args) => wrapResult(await handlers.getBookMetadata(args as any), 'get_book_metadata'),
    );

    // 9. search_by_term
    registerTool(
      'search_by_term',
      'Search for books by conceptual term (e.g., "phenomenology", "dialectic", "epistemology"). Returns books with title (string), author (string), and other metadata. Books in Z-Library are tagged with 60+ conceptual terms.',
      SearchByTermParamsSchema.shape,
      ann('search_by_term'),
      async (args) => wrapResult(await handlers.searchByTerm(args as any), 'search_by_term'),
    );

    // 10. search_by_author
    registerTool(
      'search_by_author',
      'Advanced author search with support for various name formats. Returns books with title (string), author (string), and other metadata. Use exact=true for precise matching. Filter by publication year, language, or file format.',
      SearchByAuthorParamsSchema.shape,
      ann('search_by_author'),
      async (args) => wrapResult(await handlers.searchByAuthor(args as any), 'search_by_author'),
    );

    // 11. fetch_booklist
    registerTool(
      'fetch_booklist',
      'Fetch books from an expert-curated booklist. Z-Library books belong to 11+ booklists with up to 954 books per list. Get booklist IDs from get_book_metadata.',
      FetchBooklistParamsSchema.shape,
      ann('fetch_booklist'),
      async (args) => wrapResult(await handlers.fetchBooklist(args as any), 'fetch_booklist'),
    );

    // 12. search_advanced
    registerTool(
      'search_advanced',
      'Advanced search with automatic separation of exact matches from fuzzy/approximate matches. Returns two arrays: exact_matches and fuzzy_matches, each containing books with title (string), author (string), and other metadata.',
      SearchAdvancedParamsSchema.shape,
      ann('search_advanced'),
      async (args) => wrapResult(await handlers.searchAdvanced(args as any), 'search_advanced'),
    );

    // 13. search_multi_source
    registerTool(
      'search_multi_source',
      'Compare all configured book sources and optional libgen_mcp / find_a_book backends in parallel (default source=all). Rank comparable reported quality, then reader ratings; actual clarity stays unknown. Pass matching versions to download_book_to_file for user confirmation. discovery contains metadata-only records, not downloadable books. source=auto retains Anna/LibGen fallback behavior.',
      SearchMultiSourceParamsSchema.shape,
      ann('search_multi_source'),
      async (args, extra) =>
        wrapResult(
          await handlers.searchMultiSource(args as any, extra.signal),
          'search_multi_source',
        ),
    );

    // Create and connect the Stdio transport
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('Z-Library MCP server (ESM/TS) is running via Stdio...');

    return { server, transport };
  } catch (error: any) {
    console.error('Failed to start MCP server:', error);

    if (opts.testing !== true) {
      process.exit(1);
    }
    return null;
  }
}

/**
 * Whether this module is the process entry point (as opposed to being imported).
 *
 * The original check compared `import.meta.url` against a `file://` URL built by
 * string concatenation from `process.argv[1]`. That is never equal on Windows:
 * `argv[1]` is a backslash path (`C:\app\dist\index.js`) while `import.meta.url`
 * is percent-encoded with forward slashes (`file:///C:/app/dist/index.js`), so
 * the server never auto-started and the client saw an immediate exit.
 *
 * Comparing resolved filesystem paths is correct on every platform. Exported so
 * both operands can be exercised in tests without spawning a process.
 */
export function isProcessEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  // npm installs the `zlibrary-mcp` bin as a symlink into <prefix>/bin, so
  // argv[1] is the link path while import.meta.url is the real file under the
  // package directory — a plain path.resolve comparison never matches and the
  // server silently refused to auto-start for global-install users. Resolve
  // symlinks when the path exists; fall back to lexical resolution so the
  // comparison still works for paths that do not exist on this filesystem.
  const canonical = (p: string): string => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  try {
    return canonical(fileURLToPath(moduleUrl)) === canonical(argv1);
  } catch {
    // A non-file:// URL (e.g. a bundler's virtual module) is never the entry point.
    return false;
  }
}

// Auto-start logic
if (isProcessEntryPoint(import.meta.url, process.argv[1])) {
  start().catch((err) => {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  });
}

// Export necessary components for testing
export { start, handlers, toolRegistry };
