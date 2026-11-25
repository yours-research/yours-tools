import { distillHtmlToMarkdown } from '../extractors/htmlDistiller.js';
import { rankPassagesBm25 } from '../search/bm25Ranker.js';
import type {
  DocumentFormat,
  DocumentPageSection,
  PdfBinaryExtractor,
  ReadDocumentInput,
  ReadDocumentResult,
} from '../types.js';

export interface ReadDocumentOptions {
  /** Optional external/offscreen PDF binary extractor (e.g. pdfjs-dist worker bridge). */
  pdfExtractor?: PdfBinaryExtractor;
  /** Optional map of pre-registered virtual documents (e.g. from WebDemo or Offscreen upload). */
  documentRegistry?: ReadonlyMap<string, { content: string; format?: DocumentFormat; filename?: string }>;
}

function decodeBase64Bytes(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

function bytesToLatin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i]);
  }
  return out;
}

function detectFormat(source: string, explicit?: DocumentFormat, filename?: string): Exclude<DocumentFormat, 'auto'> {
  if (explicit && explicit !== 'auto') {
    return explicit;
  }
  const lowerName = (filename ?? '').toLowerCase();
  if (lowerName.endsWith('.pdf') || source.startsWith('%PDF-') || source.startsWith('data:application/pdf')) {
    return 'pdf';
  }
  if (lowerName.endsWith('.csv')) return 'csv';
  if (lowerName.endsWith('.json')) return 'json';
  if (lowerName.endsWith('.md') || lowerName.endsWith('.markdown')) return 'markdown';
  if (lowerName.endsWith('.html') || lowerName.endsWith('.htm')) return 'html';

  const trimmed = source.trimStart();
  if (trimmed.startsWith('data:text/csv')) return 'csv';
  if (trimmed.startsWith('data:text/html')) return 'html';
  if (trimmed.startsWith('data:application/json')) return 'json';
  if (/^<!doctype\s+html|^<html\b|^<body\b|^<article\b/i.test(trimmed)) return 'html';
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed);
      return 'json';
    } catch {
      // Not valid JSON
    }
  }
  if (/^#{1,6}\s/m.test(trimmed)) return 'markdown';

  const lines = trimmed.split(/\r?\n/).slice(0, 4).filter(Boolean);
  if (lines.length >= 2 && lines[0].includes(',')) {
    const colCount = lines[0].split(',').length;
    if (colCount >= 2 && lines.slice(1).every((l) => l.split(',').length === colCount)) {
      return 'csv';
    }
  }
  return 'txt';
}

function decodePdfLiteralString(raw: string): string {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\')
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(Number.parseInt(oct, 8)));
}

/**
 * Built-in zero-dependency offline PDF text/metadata extractor for uncompressed PDF content streams
 * and PDF.js `.textLayer` snapshots. Binary FlateDecode PDFs should provide a `PdfBinaryExtractor`
 * (such as `pdfjs-dist` running inside an Offscreen Document or Web Worker).
 */
export function extractBasicPdfText(rawLatin1OrBytes: string | Uint8Array): {
  title?: string;
  author?: string;
  pages: DocumentPageSection[];
} {
  const raw = typeof rawLatin1OrBytes === 'string' ? rawLatin1OrBytes : bytesToLatin1(rawLatin1OrBytes);

  const titleMatch = /\/Title\s*\(([^)]+)\)/.exec(raw);
  const authorMatch = /\/Author\s*\(([^)]+)\)/.exec(raw);
  const title = titleMatch ? decodePdfLiteralString(titleMatch[1]).trim() : undefined;
  const author = authorMatch ? decodePdfLiteralString(authorMatch[1]).trim() : undefined;

  const pages: DocumentPageSection[] = [];
  const btRegex = /BT\b([\s\S]*?)\bET/g;
  let match: RegExpExecArray | null;
  let pageIdx = 1;

  while ((match = btRegex.exec(raw)) !== null) {
    const block = match[1];
    const parts: string[] = [];

    // Match Tj: (Hello) Tj
    const tjRegex = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
    let tj: RegExpExecArray | null;
    while ((tj = tjRegex.exec(block)) !== null) {
      parts.push(decodePdfLiteralString(tj[1]));
    }

    // Match TJ arrays: [(Hello ) -20 (World)] TJ
    const tjArrRegex = /\[([\s\S]*?)\]\s*TJ/g;
    let arrM: RegExpExecArray | null;
    while ((arrM = tjArrRegex.exec(block)) !== null) {
      const innerStrRegex = /\(((?:\\.|[^\\)])*)\)/g;
      let sm: RegExpExecArray | null;
      let combined = '';
      while ((sm = innerStrRegex.exec(arrM[1])) !== null) {
        combined += decodePdfLiteralString(sm[1]);
      }
      if (combined) parts.push(combined);
    }

    const pageText = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (pageText) {
      pages.push({ pageNumber: pageIdx++, text: pageText });
    }
  }

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    pages,
  };
}

function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"' && csvText[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field.trim());
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && csvText[i + 1] === '\n') i++;
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

function splitMarkdownPages(text: string): DocumentPageSection[] {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  if (normalized.includes('\f')) {
    return normalized
      .split('\f')
      .map((chunk, idx) => ({ pageNumber: idx + 1, text: chunk.trim() }))
      .filter((p) => p.text.length > 0);
  }

  // Group into logical sections by top-level headings or 3,000-char pages
  const lines = normalized.split('\n');
  const sections: DocumentPageSection[] = [];
  let buffer: string[] = [];
  let currentTitle: string | undefined;
  let charCount = 0;

  const flush = () => {
    const txt = buffer.join('\n').trim();
    if (txt) {
      sections.push({
        pageNumber: sections.length + 1,
        ...(currentTitle ? { title: currentTitle } : {}),
        text: txt,
      });
    }
    buffer = [];
    charCount = 0;
  };

  for (const line of lines) {
    const headingMatch = /^#{1,2}\s+(.+)$/.exec(line);
    if (headingMatch && charCount > 400) {
      flush();
      currentTitle = headingMatch[1].trim();
    } else if (headingMatch && !currentTitle) {
      currentTitle = headingMatch[1].trim();
    }
    buffer.push(line);
    charCount += line.length + 1;
    if (charCount >= 3200) {
      flush();
      currentTitle = undefined;
    }
  }
  flush();
  return sections;
}

function parsePageRange(rangeStr: string | undefined, totalPages: number): { start: number; end: number } | null {
  if (!rangeStr || !rangeStr.trim()) return null;
  const trimmed = rangeStr.trim();
  const single = /^(\d+)$/.exec(trimmed);
  if (single) {
    const n = Number.parseInt(single[1], 10);
    return { start: Math.max(1, n), end: Math.min(totalPages, n) };
  }
  const span = /^(\d+)\s*-\s*(\d+)$/.exec(trimmed);
  if (span) {
    const a = Number.parseInt(span[1], 10);
    const b = Number.parseInt(span[2], 10);
    return {
      start: Math.max(1, Math.min(a, b)),
      end: Math.min(totalPages, Math.max(a, b)),
    };
  }
  return null;
}

/**
 * Offline-first structured document reader (`read_document`) designed for Offscreen Documents,
 * Web Workers, and virtual web-demo documents.
 */
export async function readDocument(
  input: ReadDocumentInput,
  options?: ReadDocumentOptions,
): Promise<{ ok: boolean; result?: ReadDocumentResult; error?: string }> {
  let rawSource = input.source;
  let resolvedFilename = input.filename;
  let explicitFormat = input.format;

  // Check registered virtual documents if source is a lookup key
  if (options?.documentRegistry?.has(rawSource)) {
    const entry = options.documentRegistry.get(rawSource)!;
    resolvedFilename = resolvedFilename ?? entry.filename ?? rawSource;
    explicitFormat = explicitFormat && explicitFormat !== 'auto' ? explicitFormat : entry.format;
    rawSource = entry.content;
  }

  if (!rawSource || !rawSource.trim()) {
    return { ok: false, error: 'Document source is empty.' };
  }

  const maxChars = Math.max(500, Math.min(120000, input.max_chars ?? 24000));
  const format = detectFormat(rawSource, explicitFormat, resolvedFilename);

  let title = resolvedFilename;
  let author: string | undefined;
  let pages: DocumentPageSection[] = [];
  let columns: string[] | undefined;
  let rowCount: number | undefined;

  if (format === 'pdf') {
    let bytes: Uint8Array;
    if (rawSource.startsWith('data:application/pdf;base64,')) {
      bytes = decodeBase64Bytes(rawSource.slice('data:application/pdf;base64,'.length));
    } else if (/^[A-Za-z0-9+/=\s]+$/.test(rawSource) && !rawSource.startsWith('%PDF-')) {
      bytes = decodeBase64Bytes(rawSource);
    } else {
      bytes = new Uint8Array(Array.from(rawSource, (c) => c.charCodeAt(0) & 0xff));
    }

    if (options?.pdfExtractor) {
      const extracted = await options.pdfExtractor.extractPdf(bytes, { filename: resolvedFilename });
      title = extracted.title ?? title;
      author = extracted.author;
      pages = extracted.pages;
    } else {
      const basic = extractBasicPdfText(bytes);
      title = basic.title ?? title;
      author = basic.author;
      pages = basic.pages;
      if (pages.length === 0) {
        return {
          ok: false,
          error:
            'Compressed/binary PDF detected with no uncompressed text streams. Provide a PdfBinaryExtractor (e.g. pdfjs-dist in an Offscreen Document).',
        };
      }
    }
  } else if (format === 'html') {
    let htmlText = rawSource;
    if (htmlText.startsWith('data:text/html;base64,')) {
      htmlText = new TextDecoder().decode(decodeBase64Bytes(htmlText.slice('data:text/html;base64,'.length)));
    }
    const distilled = distillHtmlToMarkdown(htmlText, { maxChars: 120000 });
    title = distilled.title || title;
    pages = splitMarkdownPages(distilled.markdown);
  } else if (format === 'csv') {
    const rows = parseCsvRows(rawSource);
    if (rows.length === 0) {
      return { ok: false, error: 'CSV document contains no rows.' };
    }
    columns = rows[0];
    rowCount = Math.max(0, rows.length - 1);
    const header = `| ${columns.join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |`;
    const bodyRows = rows.slice(1).map((r) => `| ${columns!.map((_, i) => r[i] ?? '').join(' | ')} |`);
    const tableText = [header, ...bodyRows].join('\n');
    pages = [{ pageNumber: 1, title: title ?? 'CSV Table', text: tableText }];
  } else if (format === 'json') {
    try {
      const parsed = JSON.parse(rawSource);
      const pretty = JSON.stringify(parsed, null, 2);
      pages = splitMarkdownPages(pretty);
    } catch (err: unknown) {
      return {
        ok: false,
        error: `Invalid JSON document: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  } else {
    // markdown or txt
    pages = splitMarkdownPages(rawSource);
  }

  const totalPages = pages.length;
  const range = parsePageRange(input.page_range, totalPages);
  const selectedPages = range
    ? pages.filter((p) => p.pageNumber >= range.start && p.pageNumber <= range.end)
    : pages;

  const fullContent = selectedPages
    .map((p) => (totalPages > 1 ? `## Page ${p.pageNumber}${p.title ? ` — ${p.title}` : ''}\n\n${p.text}` : p.text))
    .join('\n\n');

  let content = fullContent;
  let truncated = false;

  if (input.query && input.query.trim()) {
    const ranked = rankPassagesBm25(fullContent, input.query.trim(), maxChars);
    content = ranked.excerpt;
    truncated = content.length < fullContent.length;
  } else if (fullContent.length > maxChars) {
    content = `${fullContent.slice(0, maxChars).trimEnd()}\n… [truncated]`;
    truncated = true;
  }

  return {
    ok: true,
    result: {
      metadata: {
        format,
        ...(resolvedFilename ? { filename: resolvedFilename } : {}),
        ...(title ? { title } : {}),
        ...(author ? { author } : {}),
        pageCount: totalPages,
        charCount: fullContent.length,
        truncated,
        ...(columns ? { columns } : {}),
        ...(rowCount !== undefined ? { rowCount } : {}),
      },
      pages: selectedPages,
      content,
      fullContent,
    },
  };
}
