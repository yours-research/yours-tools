import {
  cleanExtractedTextLines,
  distillHtmlToMarkdown,
  extractCleanSourceSnippet,
} from '../extractors/htmlDistiller.js';
import type { FetchedSourceResult, SearchResultItem, WebSearchResult } from '../types.js';
import { rankPassagesBm25 } from './bm25Ranker.js';

export const DEFAULT_FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev';

export interface FirecrawlKeylessOptions {
  /** Base URL for Firecrawl API or same-origin proxy (e.g. `https://api.firecrawl.dev` or `/api/firecrawl`). */
  firecrawlBaseUrl?: string;
  /** Optional API key; omitted in keyless mode so no Authorization header is sent. */
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export interface FirecrawlKeylessSearchOptions extends FirecrawlKeylessOptions {
  limit?: number;
  maxCharsPerSource?: number;
}

export interface FirecrawlKeylessScrapeOptions extends FirecrawlKeylessOptions {
  query?: string;
  maxCharsPerSource?: number;
}

interface FirecrawlRawDoc {
  url?: string;
  title?: string;
  description?: string;
  markdown?: string;
  html?: string;
  content?: string;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
  };
}

function normalizeBaseUrl(raw?: string): string {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_FIRECRAWL_BASE_URL;
  return trimmed.replace(/\/+$/, '');
}

function safeDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

async function postFirecrawlJson(
  endpointUrl: string,
  payload: Record<string, unknown>,
  options?: FirecrawlKeylessOptions,
): Promise<{ status: number; json: Record<string, unknown> | null; error?: string; rateLimited?: boolean }> {
  const fetchFn = options?.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    return { status: 0, json: null, error: 'fetch is unavailable for Firecrawl Keyless client.' };
  }

  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs ?? 12000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const apiKey = options?.apiKey?.trim();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  try {
    // Keyless mode: attach Authorization only when apiKey is explicitly provided.
    const res = await fetchFn(endpointUrl, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after');
      return {
        status: 429,
        json: null,
        rateLimited: true,
        error: `Firecrawl keyless rate limit reached (HTTP 429)${retryAfter ? `; retry after ${retryAfter}s` : ''}.`,
      };
    }

    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = (await res.json()) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      const serverMsg = typeof parsed?.error === 'string' ? parsed.error : `HTTP ${res.status}`;
      return { status: res.status, json: parsed, error: `Firecrawl error: ${serverMsg}` };
    }

    return { status: res.status, json: parsed };
  } catch (err: unknown) {
    return {
      status: 0,
      json: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeDocToMarkdown(doc: FirecrawlRawDoc, url: string): { title: string; markdown: string } {
  const metaTitle = doc.title || doc.metadata?.title || '';
  if (typeof doc.markdown === 'string' && doc.markdown.trim().length > 0) {
    return { title: metaTitle, markdown: cleanExtractedTextLines(doc.markdown) };
  }
  if (typeof doc.html === 'string' && doc.html.trim().length > 0) {
    const distilled = distillHtmlToMarkdown(doc.html, { baseUrl: url, maxChars: 16000 });
    return { title: metaTitle || distilled.title, markdown: distilled.markdown };
  }
  if (typeof doc.content === 'string' && doc.content.trim().length > 0) {
    return { title: metaTitle, markdown: cleanExtractedTextLines(doc.content) };
  }
  return { title: metaTitle, markdown: '' };
}

/**
 * Queries Firecrawl Keyless `/v2/search` without an API key (unless `apiKey` is explicitly
 * provided) and returns cleaned search + excerpt data.
 */
export async function firecrawlKeylessSearch(
  query: string,
  options?: FirecrawlKeylessSearchOptions,
): Promise<WebSearchResult & { rateLimited?: boolean }> {
  const t0 = Date.now();
  const baseUrl = normalizeBaseUrl(options?.firecrawlBaseUrl);
  const limit = Math.max(1, Math.min(10, options?.limit ?? 5));
  const maxCharsPerSource = options?.maxCharsPerSource ?? 1800;

  const res = await postFirecrawlJson(
    `${baseUrl}/v2/search`,
    {
      query,
      limit,
      scrapeOptions: { formats: ['markdown'] },
    },
    options,
  );

  if (res.error || !res.json) {
    return {
      ok: false,
      query,
      results: [],
      engine: 'firecrawl-keyless',
      elapsedMs: Date.now() - t0,
      ...(res.rateLimited ? { rateLimited: true } : {}),
      error: res.error ?? 'Invalid Firecrawl search response.',
    };
  }

  const dataField = res.json.data as { web?: unknown } | FirecrawlRawDoc[] | undefined;
  const rawRows: FirecrawlRawDoc[] = Array.isArray(dataField)
    ? dataField
    : Array.isArray(dataField?.web)
      ? (dataField.web as FirecrawlRawDoc[])
      : [];
  const results: SearchResultItem[] = [];
  const scrapedSources: FetchedSourceResult[] = [];

  for (const row of rawRows.slice(0, limit)) {
    const url = (row.url || row.metadata?.sourceURL || '').trim();
    if (!url) continue;
    const { title, markdown } = normalizeDocToMarkdown(row, url);
    const ranked = markdown
      ? rankPassagesBm25(markdown, query, maxCharsPerSource)
      : { excerpt: '', selectedChunks: 0, totalChunks: 0, topScore: 0 };
    const snippet = extractCleanSourceSnippet(
      [row.description, row.metadata?.description, ranked.excerpt, markdown],
      240,
    );

    results.push({
      title: title || url,
      url,
      snippet,
      domain: safeDomain(url),
    });

    if (ranked.excerpt) {
      scrapedSources.push({
        url,
        title: title || url,
        markdown,
        excerpt: ranked.excerpt,
        snippet,
        charCount: markdown.length,
        fromHiddenTab: false,
      });
    }
  }

  return {
    ok: results.length > 0,
    query,
    results,
    scrapedSources,
    engine: 'firecrawl-keyless',
    fromHiddenTab: false,
    elapsedMs: Date.now() - t0,
    ...(results.length === 0 ? { error: 'Firecrawl keyless search returned 0 results.' } : {}),
  };
}

/**
 * Scrapes a single URL via Firecrawl Keyless `/v2/scrape` without an API key (unless `apiKey`
 * is explicitly provided).
 */
export async function firecrawlKeylessScrape(
  url: string,
  options?: FirecrawlKeylessScrapeOptions,
): Promise<FetchedSourceResult & { rateLimited?: boolean }> {
  const baseUrl = normalizeBaseUrl(options?.firecrawlBaseUrl);
  const maxChars = options?.maxCharsPerSource ?? 1800;
  const res = await postFirecrawlJson(
    `${baseUrl}/v2/scrape`,
    {
      url,
      formats: ['markdown'],
    },
    options,
  );

  if (res.error || !res.json) {
    return {
      url,
      title: '',
      markdown: '',
      excerpt: '',
      snippet: '',
      charCount: 0,
      fromHiddenTab: false,
      ...(res.rateLimited ? { rateLimited: true } : {}),
      error: res.error ?? 'Invalid Firecrawl scrape response.',
    };
  }

  const doc = (
    res.json.data && typeof res.json.data === 'object' ? res.json.data : res.json
  ) as FirecrawlRawDoc;
  const { title, markdown } = normalizeDocToMarkdown(doc, url);
  if (!markdown) {
    return {
      url,
      title,
      markdown: '',
      excerpt: '',
      snippet: '',
      charCount: 0,
      fromHiddenTab: false,
      error: 'Firecrawl keyless scrape returned empty content.',
    };
  }

  const ranked = options?.query
    ? rankPassagesBm25(markdown, options.query, maxChars)
    : { excerpt: markdown.slice(0, maxChars), selectedChunks: 1, totalChunks: 1, topScore: 0 };
  const snippet = extractCleanSourceSnippet(
    [doc.description, doc.metadata?.description, ranked.excerpt, markdown],
    240,
  );

  return {
    url,
    title: title || url,
    markdown,
    excerpt: ranked.excerpt,
    snippet,
    charCount: markdown.length,
    fromHiddenTab: false,
  };
}
