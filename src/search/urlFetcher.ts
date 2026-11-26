import {
  distillHtmlToMarkdown,
  extractYouTubeCaptionTrack,
  parseYouTubeTranscriptXml,
} from '../extractors/htmlDistiller.js';
import type { FetchedSourceResult, HiddenTabHtmlResponse } from '../types.js';
import { rankPassagesBm25 } from './bm25Ranker.js';
import { detectAntiBotChallenge } from './webSearch.js';

export interface UrlFetcherDeps {
  hasPermission?: () => Promise<boolean>;
  fetchFn?: typeof fetch;
  openHiddenTabAndExtract?: (url: string) => Promise<HiddenTabHtmlResponse>;
  timeoutMs?: number;
}

export interface FetchAndReadOptions {
  query?: string;
  maxCharsPerSource?: number;
  concurrency?: number;
  onSourceReady?: (src: FetchedSourceResult) => void;
  deps?: UrlFetcherDeps;
}

function validateHttpUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed;
    return null;
  } catch {
    return null;
  }
}

async function fetchTextWithTimeout(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<{ status: number; text: string; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
      },
    });
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    return { status: res.status, text, contentType };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSingleSource(
  rawUrl: string,
  query: string,
  maxCharsPerSource: number,
  deps: UrlFetcherDeps,
): Promise<FetchedSourceResult> {
  const parsedUrl = validateHttpUrl(rawUrl);
  if (!parsedUrl) {
    return {
      url: rawUrl,
      title: '',
      markdown: '',
      excerpt: '',
      charCount: 0,
      fromHiddenTab: false,
      error: 'Invalid URL: only http:// and https:// protocols are allowed.',
    };
  }

  const normalizedUrl = parsedUrl.toString();
  const fetchFn = deps.fetchFn ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 12000;

  let staticStatus = 0;
  let staticHtml = '';
  let contentType = '';
  let staticError: string | undefined;

  if (fetchFn) {
    try {
      const fetched = await fetchTextWithTimeout(normalizedUrl, fetchFn, timeoutMs);
      staticStatus = fetched.status;
      staticHtml = fetched.text;
      contentType = fetched.contentType;
    } catch (err: unknown) {
      staticError = err instanceof Error ? err.message : String(err);
    }
  }

  if (staticHtml && detectAntiBotChallenge(staticHtml, staticStatus)) {
    return {
      url: normalizedUrl,
      title: '',
      markdown: '',
      excerpt: '',
      charCount: 0,
      fromHiddenTab: false,
      blockedByCaptcha: true,
      manualUrl: normalizedUrl,
      error: 'Blocked by anti-bot/CAPTCHA challenge. Open manually in a tab.',
    };
  }

  if (!staticHtml && staticStatus === 403) {
    return {
      url: normalizedUrl,
      title: '',
      markdown: '',
      excerpt: '',
      charCount: 0,
      fromHiddenTab: false,
      blockedByCaptcha: true,
      manualUrl: normalizedUrl,
      error: 'HTTP 403 challenge/access denied.',
    };
  }

  let title = '';
  let markdown = '';
  let fromHiddenTab = false;

  const host = parsedUrl.hostname.toLowerCase();
  const isYouTube = host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be';

  if (staticHtml && isYouTube && fetchFn) {
    const ytTrack = extractYouTubeCaptionTrack(staticHtml);
    if (ytTrack) {
      title = ytTrack.title;
      try {
        const xmlRes = await fetchTextWithTimeout(ytTrack.captionBaseUrl, fetchFn, timeoutMs);
        if (xmlRes.status >= 200 && xmlRes.status < 400 && xmlRes.text) {
          markdown = parseYouTubeTranscriptXml(xmlRes.text, maxCharsPerSource * 3);
        }
      } catch {
        // Fallback to HTML distillation
      }
    }
  }

  if (!markdown && staticHtml) {
    if (contentType.includes('text/plain') || contentType.includes('application/json')) {
      markdown = staticHtml.trim();
    } else {
      const distilled = distillHtmlToMarkdown(staticHtml, {
        baseUrl: normalizedUrl,
        maxChars: Math.max(maxCharsPerSource * 3, 12000),
      });
      title = title || distilled.title;
      markdown = distilled.markdown;
    }
  }

  if (markdown.length < 200 && deps.openHiddenTabAndExtract) {
    try {
      const tabRes = await deps.openHiddenTabAndExtract(normalizedUrl);
      if (tabRes.blockedByCaptcha || detectAntiBotChallenge(tabRes.html)) {
        return {
          url: normalizedUrl,
          title: tabRes.title || title,
          markdown: '',
          excerpt: '',
          charCount: 0,
          fromHiddenTab: true,
          blockedByCaptcha: true,
          manualUrl: normalizedUrl,
          error: 'Blocked by anti-bot/CAPTCHA challenge in background tab.',
        };
      }
      const tabMarkdown = tabRes.markdown?.trim();
      if (tabMarkdown && tabMarkdown.length > markdown.length) {
        title = tabRes.title || title;
        markdown = tabMarkdown;
        fromHiddenTab = true;
      } else {
        const tabDistilled = distillHtmlToMarkdown(tabRes.html, {
          baseUrl: tabRes.url ?? normalizedUrl,
          maxChars: Math.max(maxCharsPerSource * 3, 12000),
        });
        if (tabDistilled.markdown.length > markdown.length) {
          title = tabDistilled.title || tabRes.title || title;
          markdown = tabDistilled.markdown;
          fromHiddenTab = true;
        }
      }
    } catch {
      // Keep static result
    }
  }

  if (!markdown) {
    return {
      url: normalizedUrl,
      title,
      markdown: '',
      excerpt: '',
      charCount: 0,
      fromHiddenTab,
      error: staticError ?? (staticStatus >= 400 ? `HTTP ${staticStatus}` : 'No readable content extracted.'),
    };
  }

  const ranked = rankPassagesBm25(markdown, query, maxCharsPerSource);
  return {
    url: normalizedUrl,
    title,
    markdown,
    excerpt: ranked.excerpt,
    charCount: markdown.length,
    fromHiddenTab,
  };
}

export async function runFetchAndReadUrls(
  urls: string[],
  options?: FetchAndReadOptions,
): Promise<FetchedSourceResult[]> {
  const targetUrls = urls.slice(0, 5);
  if (targetUrls.length === 0) return [];

  const deps = options?.deps ?? {};
  const hasPermission = await (deps.hasPermission ? deps.hasPermission() : Promise.resolve(false));
  if (!hasPermission) {
    return targetUrls.map((url) => {
      const item: FetchedSourceResult = {
        url,
        title: '',
        markdown: '',
        excerpt: '',
        charCount: 0,
        fromHiddenTab: false,
        error: 'Host permission or explicit policy approval is required before fetching URLs.',
      };
      options?.onSourceReady?.(item);
      return item;
    });
  }

  const query = options?.query ?? '';
  const maxCharsPerSource = options?.maxCharsPerSource ?? 3200;
  const concurrency = Math.max(1, Math.min(5, options?.concurrency ?? 3));

  const results: FetchedSourceResult[] = new Array(targetUrls.length);
  let nextIdx = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= targetUrls.length) return;
      const res = await fetchSingleSource(targetUrls[idx], query, maxCharsPerSource, deps);
      results[idx] = res;
      options?.onSourceReady?.(res);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, targetUrls.length) }, () => worker()));
  return results;
}
