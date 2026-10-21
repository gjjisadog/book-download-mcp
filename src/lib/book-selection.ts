import type { Server } from '@modelcontextprotocol/sdk/server/index.js';

export type BookCandidate = Record<string, any>;

function score(book: BookCandidate, field: 'quality' | 'rating') {
  const raw = field === 'quality' ? (book.quality_score ?? book.quality) : book.rating;
  const value = raw && typeof raw === 'object' ? raw.value : raw;
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
        ? Number(value)
        : NaN;
  const max = Number(raw?.max ?? book[`${field}_max`]);
  if (!Number.isFinite(number) || number < 0) return null;
  if (Number.isFinite(max) && max > 0) return number <= max ? { value: number, max } : null;
  return { value: number, max: null };
}

/** Compare reported scores only when their scale or common source is known. */
export function rankBookCandidates(books: BookCandidate[]): BookCandidate[] {
  const comparable = (field: 'quality' | 'rating') => {
    const rated = books.filter((book) => score(book, field) !== null);
    const normalized = rated.every((book) => score(book, field)!.max !== null);
    const sources = new Set(rated.map((book) => book.source));
    const sameSource =
      sources.size === 1 &&
      !sources.has(undefined) &&
      !sources.has('') &&
      rated.every((book) => score(book, field)!.max === null);
    return (book: BookCandidate) => {
      const s = score(book, field);
      if (!s || (!normalized && !sameSource)) return -1;
      return normalized ? s.value / s.max! : s.value;
    };
  };
  const quality = comparable('quality');
  const rating = comparable('rating');
  return books
    .map((book, index) => ({ book, index }))
    .sort(
      (a, b) =>
        quality(b.book) - quality(a.book) || rating(b.book) - rating(a.book) || a.index - b.index,
    )
    .map(({ book }) => ({
      ...book,
      recommendation: {
        reported_quality: score(book, 'quality'),
        reported_rating: score(book, 'rating'),
        clarity: 'unverified',
        reasons: [
          quality(book) >= 0
            ? 'Reported quality score (comparable scale/source)'
            : 'Quality unknown or incomparable',
          rating(book) >= 0
            ? 'Reported reader rating (comparable scale/source)'
            : 'Reader rating unknown or incomparable',
        ],
      },
    }));
}

function label(book: BookCandidate, index: number): string {
  const text = (value: unknown) =>
    String(value ?? '')
      .replace(/[\r\n\t]/g, ' ')
      .slice(0, 120);
  const quality = score(book, 'quality');
  const rating = score(book, 'rating');
  return [
    index === 0
      ? book.recommendation?.reasons.some((reason: string) => reason.startsWith('Reported'))
        ? '优先推荐'
        : '首个候选（评分不足）'
      : `候选 ${index + 1}`,
    text(book.title || book.name),
    text(book.author),
    text(book.origin ? `${book.source}/${book.origin}` : book.source || 'zlibrary'),
    text(book.language || '语言未知'),
    text(book.year || '年份未知'),
    text(book.extension || '格式未知'),
    text(book.size || book.filesize || '大小未知'),
    `来源质量评分 ${quality ? quality.value + (quality.max ? `/${quality.max}` : '（量表未提供）') : '未知'}`,
    `读者评价 ${rating ? rating.value + (rating.max ? `/${rating.max}` : '（量表未提供）') : '未知'}`,
  ].join(' · ');
}

export async function selectDownload(
  args: {
    bookDetails: BookCandidate;
    alternatives?: BookCandidate[];
    confirmed?: boolean;
    outputDir?: string;
    process_for_rag?: boolean;
  },
  server?: Pick<Server, 'getClientCapabilities' | 'elicitInput'>,
  signal?: AbortSignal,
): Promise<{
  book?: BookCandidate;
  status?: string;
  candidates?: BookCandidate[];
  message?: string;
}> {
  // A prior conversational confirmation applies to this exact book, never a newly ranked alternative.
  if (args.confirmed) return { book: args.bookDetails };
  const candidates = rankBookCandidates([args.bookDetails, ...(args.alternatives ?? [])]);
  const elicitation = server?.getClientCapabilities()?.elicitation;
  const supportsForm = elicitation?.form !== undefined;
  const message =
    '请确认下载版本。优先参考可比较的来源质量评分，再参考读者评价；未知评分不代表质量差，尚未验证实际清晰度。请核对书名、作者、语言和版本。';
  if (!supportsForm)
    return {
      status: 'confirmation_required',
      candidates,
      message: `${message} 请在对话中让用户选择，再以选定的 bookDetails 和 confirmed=true 调用下载；不要自行确认。`,
    };
  const response = await server!.elicitInput(
    {
      mode: 'form',
      message: `${message}\n保存到：${args.outputDir ?? './downloads'}${args.process_for_rag ? '\n下载后提取 RAG 文本。' : ''}`,
      requestedSchema: {
        type: 'object',
        properties: {
          version: {
            type: 'string',
            title: '选择要下载的版本',
            enum: candidates.map((_, index) => String(index)),
            enumNames: candidates.map(label),
          },
        },
        required: ['version'],
      },
    },
    { signal, timeout: 120000 },
  );
  if (response.action !== 'accept')
    return { status: 'cancelled', message: '用户取消，未下载文件。' };
  const choice = response.content?.version;
  if (typeof choice !== 'string' || !candidates.some((_, index) => String(index) === choice))
    throw new Error('No valid book version was confirmed; nothing downloaded');
  return { book: candidates[Number(choice)] };
}
