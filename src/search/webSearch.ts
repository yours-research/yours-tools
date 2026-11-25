import { decodeHtmlEntities } from '../extractors/htmlDistiller.js';
import type {
  ChromiumSerpResponse,
  HiddenTabHtmlResponse,
  SearchResultItem,
  WebSearchResult,
} from '../types.js';

const HARD_INTERSTITIAL_PATTERNS = [
  /verify you are human/i,
  /are you a robot/i,
  /please complete the security check/i,
  /unusual traffic from your computer/i,
  /duckduckgo\.com\/anomaly\.js/i,
  /anomaly-modal/i,
  /captcha[-_]?form/i,
  /solve the captcha/i,
];

const CHALLENGE_PLATFORM_PATTERNS = [
  /challenges\.cloudflare\.com/i,
  /\/cdn-cgi\/challenge-platform/i,
];

const SOFT_WIDGET_PATTERNS = [
  /cf-turnstile/i,
  /\bg-recaptcha\b/i,
  /\bhcaptcha\b/i,
  /data-sitekey/i,
];

function extractVisibleTextLength(html: string): number {
  if (!html) return 0;
  const stripped = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length;
}

export function detectAntiBotChallenge(html: string, status?: number): boolean {
  if (status === 429) return true;
  const text = html || '';
  for (const pattern of HARD_INTERSTITIAL_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  const visibleTextLen = extractVisibleTextLength(text);
  for (const pattern of CHALLENGE_PLATFORM_PATTERNS) {
    if (pattern.test(text) && (status === 403 || status === 503 || visibleTextLen < 1500)) {
      return true;
    }
  }
  for (const pattern of SOFT_WIDGET_PATTERNS) {
    if (pattern.test(text) && (status === 403 || status === 503 || status === 202 || visibleTextLen < 600)) {
      return true;
    }
  }
  if (status === 403) {
    if (
      text.length < 15000 &&
      /(cloudflare|just a moment|attention required|access denied|captcha|bot|security check|forbidden)/i.test(text)
    ) {
      return true;
    }
    return visibleTextLen === 0;
  }
  return false;
}

export function unwrapBingRedirectUrl(rawHref: string): string | null {
  const decodedHref = decodeHtmlEntities(rawHref).trim();
  if (!decodedHref) return null;
  try {
    const parsed = new URL(decodedHref, 'https://www.bing.com');
    if (
      (parsed.hostname === 'www.bing.com' || parsed.hostname.endsWith('.bing.com')) &&
      parsed.pathname.startsWith('/ck/a')
    ) {
      const encodedParam = parsed.searchParams.get('u');
      if (encodedParam && encodedParam.startsWith('a1') && encodedParam.length > 2) {
        let b64 = encodedParam.slice(2).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4 !== 0) b64 += '=';
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const target = new URL(new TextDecoder().decode(bytes));
        if (target.protocol === 'http:' || target.protocol === 'https:') return target.toString();
      }
      return null;
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

function unwrapDuckDuckGoHref(rawHref: string): string | null {
  const decodedHref = decodeHtmlEntities(rawHref).trim();
  if (!decodedHref) return null;
  let normalizedHref = decodedHref;
  if (normalizedHref.startsWith('//')) normalizedHref = `https:${normalizedHref}`;
  else if (normalizedHref.startsWith('/')) normalizedHref = `https://duckduckgo.com${normalizedHref}`;

  try {
    const parsed = new URL(normalizedHref);
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/l/')) {
      const uddg = parsed.searchParams.get('uddg');
      if (uddg) {
        const target = new URL(uddg);
        if (target.protocol === 'http:' || target.protocol === 'https:') return target.toString();
      }
      return null;
    }
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/y.js')) return null;
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
    return null;
  } catch {
    return null;
  }
}

function stripTagsClean(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseDuckDuckGoHtmlResults(html: string, limit = 5): SearchResultItem[] {
  if (!html) return [];
  const maxResults = Math.max(1, Math.min(10, Math.round(limit)));
  const items: SearchResultItem[] = [];
  const seenUrls = new Set<string>();

  const pushItem = (rawHref: string, rawTitle: string, rawSnippet: string) => {
    if (items.length >= maxResults) return;
    const url = unwrapDuckDuckGoHref(rawHref);
    if (!url || seenUrls.has(url)) return;
    const title = stripTagsClean(rawTitle);
    const snippet = stripTagsClean(rawSnippet);
    if (!title) return;
    try {
      const domain = new URL(url).hostname.replace(/^www\./, '');
      seenUrls.add(url);
      items.push({ title, url, snippet, domain });
    } catch {
      // ignore invalid URL
    }
  };

  const linkAnchorRegex = /<a\b([^>]*class\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  const anchorMatches: Array<{ index: number; href: string; titleHtml: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = linkAnchorRegex.exec(html)) !== null) {
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    const href = hrefMatch ? hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '' : '';
    anchorMatches.push({ index: match.index, href, titleHtml: match[2] });
  }

  for (let i = 0; i < anchorMatches.length && items.length < maxResults; i++) {
    const cur = anchorMatches[i];
    const nextStart = i + 1 < anchorMatches.length ? anchorMatches[i + 1].index : html.length;
    const blockSlice = html.slice(cur.index, Math.min(nextStart, cur.index + 4000));
    const snippetMatch =
      /<(?:a|div|span|td)\b[^>]*class\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i.exec(
        blockSlice,
      );
    pushItem(cur.href, cur.titleHtml, snippetMatch ? snippetMatch[1] : '');
  }

  if (items.length > 0) return items;

  const liteRegex = /<a\b([^>]*class\s*=\s*["'][^"']*\bresult-link\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  const liteMatches: Array<{ index: number; href: string; titleHtml: string }> = [];
  while ((match = liteRegex.exec(html)) !== null) {
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    const href = hrefMatch ? hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '' : '';
    liteMatches.push({ index: match.index, href, titleHtml: match[2] });
  }

  for (let i = 0; i < liteMatches.length && items.length < maxResults; i++) {
    const cur = liteMatches[i];
    const nextStart = i + 1 < liteMatches.length ? liteMatches[i + 1].index : html.length;
    const blockSlice = html.slice(cur.index, Math.min(nextStart, cur.index + 3000));
    const snippetMatch =
      /<td\b[^>]*class\s*=\s*["'][^"']*\bresult-snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i.exec(blockSlice);
    pushItem(cur.href, cur.titleHtml, snippetMatch ? snippetMatch[1] : '');
  }

  return items;
}

export function parseBingWebHtmlResults(html: string, limit = 5): SearchResultItem[] {
  if (!html) return [];
  const maxResults = Math.max(1, Math.min(10, Math.round(limit)));
  const items: SearchResultItem[] = [];
  const seenUrls = new Set<string>();
  const liRegex = /<li\b([^>]*class\s*=\s*["'][^"']*\bb_algo\b[^"']*["'][^>]*)>([\s\S]*?)<\/li>/gi;
  let match: RegExpExecArray | null;

  while ((match = liRegex.exec(html)) !== null && items.length < maxResults) {
    const block = match[2];
    const h2Anchor =
      /<h2\b[^>]*>[\s\S]*?<a\b([^>]*)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(
        block,
      );
    if (!h2Anchor) continue;
    const rawHref = h2Anchor[2] ?? h2Anchor[3] ?? h2Anchor[4] ?? '';
    const resolvedUrl = unwrapBingRedirectUrl(rawHref);
    if (!resolvedUrl || seenUrls.has(resolvedUrl)) continue;
    const title = stripTagsClean(h2Anchor[6]);
    if (!title) continue;
    const snippetMatch =
      /<p\b[^>]*class\s*=\s*["'][^"']*\bb_algoSlug\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<div\b[^>]*class\s*=\s*["'][^"']*\bb_caption\b[^"']*["'][^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block) ??
      /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = snippetMatch ? stripTagsClean(snippetMatch[1]) : '';
    try {
      const domain = new URL(resolvedUrl).hostname.replace(/^www\./, '');
      seenUrls.add(resolvedUrl);
      items.push({ title, url: resolvedUrl, snippet, domain });
    } catch {
      // ignore invalid URL
    }
  }
  return items;
}

export function parseStartpageHtmlResults(html: string, limit = 5): SearchResultItem[] {
  if (!html) return [];
  const maxResults = Math.max(1, Math.min(10, Math.round(limit)));
  const items: SearchResultItem[] = [];
  const seenUrls = new Set<string>();
  const blockRegex =
    /<a\b([^>]*class\s*=\s*["'][^"']*\b(?:w-gl__result-title|result-title)\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;
  const matches: Array<{ index: number; href: string; titleHtml: string }> = [];
  let m: RegExpExecArray | null;

  while ((m = blockRegex.exec(html)) !== null) {
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(m[1]);
    const href = hrefMatch ? hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '' : '';
    matches.push({ index: m.index, href, titleHtml: m[2] });
  }

  for (let i = 0; i < matches.length && items.length < maxResults; i++) {
    const cur = matches[i];
    const nextIdx = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const slice = html.slice(cur.index, Math.min(nextIdx, cur.index + 3000));
    const urlStr = decodeHtmlEntities(cur.href).trim();
    if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) continue;
    if (seenUrls.has(urlStr)) continue;
    const title = stripTagsClean(cur.titleHtml);
    if (!title) continue;
    const snippetMatch =
      /<p\b[^>]*class\s*=\s*["'][^"']*\bw-gl__description\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(slice) ??
      /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(slice);
    const snippet = snippetMatch ? stripTagsClean(snippetMatch[1]) : '';
    try {
      const domain = new URL(urlStr).hostname.replace(/^www\./, '');
      seenUrls.add(urlStr);
      items.push({ title, url: urlStr, snippet, domain });
    } catch {
      // ignore invalid URL
    }
  }
  return items;
}

export interface WebSearchDeps {
  hasPermission?: () => Promise<boolean>;
  searchViaChromiumSerp?: (query: string, limit: number) => Promise<ChromiumSerpResponse>;
  fetchFn?: typeof fetch;
  openHiddenTabAndExtract?: (url: string) => Promise<HiddenTabHtmlResponse>;
  timeoutMs?: number;
}

export async function runWebSearch(
  query: string,
  limit = 5,
  deps?: WebSearchDeps,
): Promise<WebSearchResult> {
  const cleanQuery = query.trim();
  const clampedLimit = Math.max(1, Math.min(10, Math.round(limit)));
  if (!cleanQuery) {
    return { ok: false, query: cleanQuery, results: [], error: 'Search query cannot be empty.' };
  }

  // Fail-closed permission gate before any network or hidden-tab access
  const hasPermission = await (deps?.hasPermission ? deps.hasPermission() : Promise.resolve(false));
  if (!hasPermission) {
    return {
      ok: false,
      query: cleanQuery,
      results: [],
      needsPermission: true,
      error: 'Host permission or explicit policy approval is required before running search_web_tab.',
    };
  }

  if (deps?.searchViaChromiumSerp) {
    try {
      const serp = await deps.searchViaChromiumSerp(cleanQuery, clampedLimit);
      return {
        ok: serp.ok,
        query: cleanQuery,
        results: serp.results ?? [],
        fromHiddenTab: true,
        engine: serp.engine,
        elapsedMs: serp.elapsedMs,
        ...(serp.blockedByCaptcha ? { blockedByCaptcha: true, manualUrl: serp.manualUrl } : {}),
        ...(serp.error ? { error: serp.error } : {}),
      };
    } catch (err: unknown) {
      return {
        ok: false,
        query: cleanQuery,
        results: [],
        fromHiddenTab: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanQuery)}`;
  const fetchFn = deps?.fetchFn ?? globalThis.fetch;
  const timeoutMs = deps?.timeoutMs ?? 10000;

  let pathAStatus: number | undefined;
  let pathAHtml = '';

  if (fetchFn) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchFn(searchUrl, {
          method: 'GET',
          signal: controller.signal,
          headers: { Accept: 'text/html,application/xhtml+xml' },
        });
        pathAStatus = response.status;
        pathAHtml = await response.text();
      } finally {
        clearTimeout(timer);
      }

      if (detectAntiBotChallenge(pathAHtml, pathAStatus)) {
        return {
          ok: false,
          query: cleanQuery,
          results: [],
          blockedByCaptcha: true,
          manualUrl: searchUrl,
          error: 'Search returned an anti-bot/CAPTCHA challenge. Open manually.',
        };
      }

      if (pathAStatus >= 200 && pathAStatus < 400) {
        const parsed = parseDuckDuckGoHtmlResults(pathAHtml, clampedLimit);
        if (parsed.length > 0) {
          return { ok: true, query: cleanQuery, results: parsed, fromHiddenTab: false };
        }
      }
    } catch {
      // Fall through to hidden-tab fallback
    }
  }

  if (deps?.openHiddenTabAndExtract) {
    try {
      const tabRes = await deps.openHiddenTabAndExtract(searchUrl);
      if (tabRes.blockedByCaptcha || detectAntiBotChallenge(tabRes.html)) {
        return {
          ok: false,
          query: cleanQuery,
          results: [],
          fromHiddenTab: true,
          blockedByCaptcha: true,
          manualUrl: searchUrl,
          error: 'Search blocked by anti-bot/CAPTCHA challenge in background tab.',
        };
      }
      const parsed = parseDuckDuckGoHtmlResults(tabRes.html, clampedLimit);
      return {
        ok: parsed.length > 0,
        query: cleanQuery,
        results: parsed,
        fromHiddenTab: true,
        ...(parsed.length === 0 ? { error: 'No search results found.' } : {}),
      };
    } catch (err: unknown) {
      return {
        ok: false,
        query: cleanQuery,
        results: [],
        fromHiddenTab: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    ok: false,
    query: cleanQuery,
    results: [],
    error: pathAStatus
      ? `Search request failed with status ${pathAStatus} and returned 0 results.`
      : 'Search request failed or returned 0 results.',
  };
}
