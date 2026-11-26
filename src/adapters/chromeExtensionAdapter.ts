import { formatInteractResult, inPageInteractScript } from '../actions/interactPage.js';
import type { InteractExecutionOutcome } from '../actions/interactPage.js';
import { readDocument, type ReadDocumentOptions } from '../documents/documentReader.js';
import { parseYouTubeTranscriptXml } from '../extractors/htmlDistiller.js';
import { inPageExtractScript } from '../extractors/pageExtractor.js';
import { formatSemanticSnapshot, inPageSemanticExtractScript } from '../extractors/semanticAom.js';
import { runSandbox, type SandboxOptions } from '../sandbox/sandbox.js';
import { runFetchAndReadUrls, type UrlFetcherDeps } from '../search/urlFetcher.js';
import { runWebSearch, type WebSearchDeps } from '../search/webSearch.js';
import type {
  ChromiumSerpResponse,
  ExtractedPageContent,
  FetchedSourceResult,
  HiddenTabHtmlResponse,
  InteractPageInput,
  InteractPageResult,
  OpenTabInfo,
  PdfBinaryExtractor,
  QuickJsRuntimeAdapter,
  ReadDocumentInput,
  ReadDocumentResult,
  RunSandboxInput,
  RunSandboxResult,
  SemanticSnapshot,
  ToolInvocationContext,
  WebSearchEngine,
  WebSearchResult,
} from '../types.js';
import type {
  AdapterOutcome,
  FetchBackgroundAdapterOptions,
  ReadPageAdapterOptions,
  SearchWebAdapterOptions,
  ToolHostAdapter,
} from './types.js';

export interface ChromeTabRecord {
  id?: number;
  title?: string;
  url?: string;
  active?: boolean;
  windowId: number;
  lastAccessed?: number;
}

export interface ChromeApiBindings {
  tabs?: {
    query(queryInfo: { active?: boolean; lastFocusedWindow?: boolean; currentWindow?: boolean }): Promise<ChromeTabRecord[]>;
    create?(createProperties: { url: string; active?: boolean }): Promise<ChromeTabRecord>;
    remove?(tabIds: number | number[]): Promise<void>;
  };
  scripting?: {
    executeScript<TArgs extends unknown[], TResult>(injection: {
      target: { tabId: number };
      func: (...args: TArgs) => TResult;
      args?: TArgs;
    }): Promise<Array<{ result?: TResult }>>;
  };
  permissions?: {
    contains(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
    request(permissions: { origins?: string[]; permissions?: string[] }): Promise<boolean>;
  };
  offscreen?: {
    hasDocument?(): Promise<boolean>;
    createDocument(parameters: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
  };
  runtime?: {
    sendMessage<TRes = unknown>(message: unknown): Promise<TRes>;
  };
}

export interface ChromeExtensionAdapterOptions {
  /** Optional typed Chrome API bindings; falls back safely to `globalThis.chrome` if present. */
  chromeApi?: ChromeApiBindings;
  /** Optional override for host permission check (`https` wildcard). */
  hasPermission?: () => Promise<boolean>;
  /** Prefer headless HTTP fetch (`html.duckduckgo.com` / `lite.duckduckgo.com`) before browser SERP tabs (default true). */
  preferHeadlessFetch?: boolean;
  /** Default search engine for headless search and background tab fallback (default 'ddg'). */
  defaultEngine?: WebSearchEngine;
  /** Optional Chromium hidden-window SERP provider. */
  searchViaChromiumSerp?: WebSearchDeps['searchViaChromiumSerp'];
  /** Optional custom fetch implementation. */
  fetchFn?: typeof fetch;
  /** Optional hidden-tab extractor hook. */
  openHiddenTabAndExtract?: (url: string) => Promise<HiddenTabHtmlResponse>;
  /** Optional offscreen document URL for PDF/document parsing. */
  offscreenDocumentUrl?: string;
  /** Optional local PDF extractor (for Worker/Offscreen `pdfjs-dist`). */
  pdfExtractor?: PdfBinaryExtractor;
  /** Optional QuickJS-WASM runtime adapter for `run_sandbox`. */
  quickJsAdapter?: QuickJsRuntimeAdapter;
  /** Optional callback when a source is ready during `fetch_background_tab` or `search_web_tab`. */
  onSourceReady?: (src: FetchedSourceResult) => void;
}

function resolveChromeApi(override?: ChromeApiBindings): ChromeApiBindings | undefined {
  if (override) return override;
  const g = globalThis as unknown as { chrome?: ChromeApiBindings };
  return g.chrome;
}

function isNormalWebUrl(url?: string): boolean {
  return typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://'));
}

/**
 * Chromium MV3 Adapter implementing `ToolHostAdapter` over `chrome.tabs`, `chrome.scripting`,
 * `chrome.permissions`, and `chrome.offscreen` with zero crashes in non-Chrome environments.
 */
export class ChromeExtensionAdapter implements ToolHostAdapter {
  readonly environment = 'chrome-mv3' as const;
  private readonly options: ChromeExtensionAdapterOptions;

  constructor(options: ChromeExtensionAdapterOptions = {}) {
    this.options = options;
  }

  private getChrome(): ChromeApiBindings | undefined {
    return resolveChromeApi(this.options.chromeApi);
  }

  async checkHostPermission(): Promise<boolean> {
    if (this.options.hasPermission) {
      return this.options.hasPermission();
    }
    const api = this.getChrome();
    if (!api?.permissions?.contains) {
      return false;
    }
    try {
      return await api.permissions.contains({ origins: ['https://*/*'] });
    } catch {
      return false;
    }
  }

  async requestHostPermission(): Promise<boolean> {
    const api = this.getChrome();
    if (!api?.permissions?.request) {
      return false;
    }
    try {
      return await api.permissions.request({ origins: ['https://*/*'] });
    } catch {
      return false;
    }
  }

  async listTabs(
    windowScope: 'current' | 'all',
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<OpenTabInfo[]>> {
    const api = this.getChrome();
    if (!api?.tabs?.query) {
      return { ok: false, error: 'chrome.tabs API is unavailable in this runtime.' };
    }
    try {
      const rawTabs = await api.tabs.query(windowScope === 'current' ? { currentWindow: true } : {});
      const tabs: OpenTabInfo[] = rawTabs
        .filter((t): t is ChromeTabRecord & { id: number } => typeof t.id === 'number')
        .map((t) => ({
          id: t.id,
          title: t.title ?? '',
          url: t.url ?? '',
          active: Boolean(t.active),
          windowId: t.windowId,
        }));
      return { ok: true, data: tabs };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async getActiveTabId(): Promise<number | null> {
    const api = this.getChrome();
    if (!api?.tabs?.query) return null;

    const focusedTabs = await api.tabs.query({ active: true, lastFocusedWindow: true });
    const focused = focusedTabs[0];
    if (focused?.id !== undefined && isNormalWebUrl(focused.url)) {
      return focused.id;
    }

    const allActive = await api.tabs.query({ active: true });
    const activeWeb = allActive.find((t) => t.id !== undefined && isNormalWebUrl(t.url));
    if (activeWeb?.id !== undefined) {
      return activeWeb.id;
    }

    const allTabs = await api.tabs.query({});
    const webTabs = allTabs
      .filter((t): t is ChromeTabRecord & { id: number } => t.id !== undefined && isNormalWebUrl(t.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    if (webTabs[0]) return webTabs[0].id;

    return focused?.id ?? allActive[0]?.id ?? null;
  }

  async readActiveTab(
    options: ReadPageAdapterOptions,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ExtractedPageContent>> {
    const tabId = await this.getActiveTabId();
    if (tabId === null) {
      return { ok: false, error: 'No active browser tab found.' };
    }
    return this.readTab(tabId, options, ctx);
  }

  async readTab(
    tabId: number,
    options: ReadPageAdapterOptions,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ExtractedPageContent>> {
    const api = this.getChrome();
    if (!api?.scripting?.executeScript) {
      return { ok: false, error: 'chrome.scripting API is unavailable in this runtime.' };
    }

    try {
      if (options.mode === 'aom') {
        const res = await api.scripting.executeScript({
          target: { tabId },
          func: inPageSemanticExtractScript,
          args: [120, options.max_chars, options.include_links],
        });
        const snapshot = res?.[0]?.result as SemanticSnapshot | undefined;
        if (!snapshot) {
          return { ok: false, error: 'Page script returned no semantic snapshot.' };
        }
        const compact = snapshot.compactText || formatSemanticSnapshot(snapshot);
        const page: ExtractedPageContent = {
          mode: 'aom',
          title: snapshot.title,
          url: snapshot.url,
          content: compact,
          fullContent: compact,
          outline: snapshot.outline,
          viewportExcerpt: snapshot.viewportExcerpt,
          semanticSnapshot: snapshot,
          contentHash: `${compact.length.toString(16)}`,
          charCount: compact.length,
          truncated: compact.endsWith('… [truncated]'),
        };
        return { ok: true, data: page };
      }

      const injections = await api.scripting.executeScript({
        target: { tabId },
        func: inPageExtractScript,
        args: [options.mode, options.max_chars, options.include_links],
      });
      const extracted = injections?.[0]?.result as ExtractedPageContent | undefined;
      if (!extracted) {
        return {
          ok: false,
          error: 'Page script returned no result (restricted chrome:// or extension page?).',
        };
      }

      if (extracted.mode === 'youtube' && extracted.youtubeCaptionUrl && !extracted.content) {
        const canFetch = await this.checkHostPermission();
        if (canFetch && (this.options.fetchFn ?? globalThis.fetch)) {
          try {
            const fetchFn = this.options.fetchFn ?? globalThis.fetch;
            const xml = await (await fetchFn(extracted.youtubeCaptionUrl)).text();
            const transcript = parseYouTubeTranscriptXml(xml, options.max_chars);
            if (transcript) {
              return {
                ok: true,
                data: {
                  ...extracted,
                  content: transcript,
                  charCount: transcript.length,
                  truncated: transcript.endsWith('… [truncated]'),
                },
              };
            }
          } catch {
            // Keep extracted metadata cleanly
          }
        }
      }

      if (extracted.error && !extracted.content) {
        return { ok: false, data: extracted, error: extracted.error };
      }
      return { ok: true, data: extracted };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async interactPage(
    input: InteractPageInput,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<InteractPageResult>> {
    const api = this.getChrome();
    if (!api?.scripting?.executeScript) {
      return { ok: false, error: 'chrome.scripting API is unavailable in this runtime.' };
    }

    const tabId = input.tab_id ?? (await this.getActiveTabId());
    if (tabId === null) {
      return { ok: false, error: 'No target browser tab found for interact_page.' };
    }

    try {
      const injections = await api.scripting.executeScript({
        target: { tabId },
        func: inPageInteractScript,
        args: [input],
      });
      const outcome = injections?.[0]?.result as InteractExecutionOutcome | undefined;
      if (!outcome) {
        return { ok: false, error: 'Page interaction script returned no result.' };
      }
      if (!outcome.ok || !outcome.result) {
        return {
          ok: false,
          requiresApproval: outcome.requiresApproval,
          error: outcome.error ?? 'Page interaction failed.',
        };
      }
      return {
        ok: true,
        data: outcome.result,
        formatted: formatInteractResult(outcome.result),
        sourceOrigin: ctx.origin,
      };
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async readDocument(
    input: ReadDocumentInput,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ReadDocumentResult>> {
    const api = this.getChrome();

    // If an Offscreen Document bridge is configured in MV3, delegate heavy binary parsing to it
    if (this.options.offscreenDocumentUrl && api?.offscreen?.createDocument && api.runtime?.sendMessage) {
      try {
        const exists = api.offscreen.hasDocument ? await api.offscreen.hasDocument() : false;
        if (!exists) {
          await api.offscreen.createDocument({
            url: this.options.offscreenDocumentUrl,
            reasons: ['DOM_PARSER'],
            justification: 'Offline local parsing of PDF/HTML/CSV documents via @yours/tools.',
          });
        }
        const remote = await api.runtime.sendMessage<{
          ok: boolean;
          result?: ReadDocumentResult;
          error?: string;
        }>({
          type: 'YOURS_READ_DOCUMENT',
          payload: input,
        });
        if (remote && typeof remote.ok === 'boolean') {
          return { ok: remote.ok, data: remote.result, error: remote.error };
        }
      } catch {
        // Fallback to local parser below
      }
    }

    const docOpts: ReadDocumentOptions = {
      pdfExtractor: this.options.pdfExtractor,
    };
    const res = await readDocument(input, docOpts);
    return {
      ok: res.ok,
      data: res.result,
      error: res.error,
    };
  }

  async runSandbox(
    input: RunSandboxInput,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<RunSandboxResult>> {
    const sandboxOpts: SandboxOptions = {
      quickJsAdapter: this.options.quickJsAdapter,
    };
    const result = await runSandbox(input, sandboxOpts);
    return {
      ok: result.ok,
      data: result,
      formatted: result.formatted,
      error: result.error,
    };
  }

  async searchWebTab(
    query: string,
    options: SearchWebAdapterOptions,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<WebSearchResult>> {
    const granted = await this.checkHostPermission();
    if (!granted) {
      return {
        ok: false,
        needsPermission: true,
        error: 'Optional host permission (https://*/*) is required for search_web_tab.',
      };
    }

    const searchDeps: WebSearchDeps = {
      hasPermission: async () => true,
      preferHeadlessFetch: this.options.preferHeadlessFetch,
      defaultEngine: this.options.defaultEngine,
      searchViaChromiumSerp: this.options.searchViaChromiumSerp,
      fetchFn: this.options.fetchFn,
      openHiddenTabAndExtract: this.options.openHiddenTabAndExtract,
    };

    const res = await runWebSearch(query, options.max_results, searchDeps);
    if (res.blockedByCaptcha) {
      return {
        ok: false,
        data: res,
        blockedByCaptcha: true,
        manualUrl: res.manualUrl,
        error: res.error,
      };
    }
    if (!res.ok) {
      return { ok: false, data: res, error: res.error };
    }

    const formattedResults = res.results
      .map((r, i) => {
        const snippet = r.snippet.replace(/\s+/g, ' ').trim().slice(0, 150);
        return `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${snippet}`;
      })
      .join('\n\n');

    const hasScrapeTransport = Boolean(
      this.options.fetchFn ||
        typeof globalThis.fetch === 'function' ||
        this.options.searchViaChromiumSerp ||
        this.options.openHiddenTabAndExtract,
    );
    const readTopN = options.read_top_n ?? (hasScrapeTransport ? 2 : 0);

    if (readTopN > 0 && res.results.length > 0 && (hasScrapeTransport || options.read_top_n !== undefined)) {
      const pickedUrls: string[] = [];
      const seenDomains = new Set<string>();
      for (const item of res.results) {
        if (pickedUrls.length >= readTopN) break;
        if (!seenDomains.has(item.domain)) {
          seenDomains.add(item.domain);
          pickedUrls.push(item.url);
        }
      }
      if (pickedUrls.length > 0) {
        const scraped = await runFetchAndReadUrls(pickedUrls, {
          query,
          maxCharsPerSource: 650,
          concurrency: 3,
          onSourceReady: this.options.onSourceReady,
          deps: {
            hasPermission: async () => true,
            fetchFn: this.options.fetchFn,
            openHiddenTabAndExtract: this.options.openHiddenTabAndExtract,
            timeoutMs: 6500,
          },
        });
        const usable = scraped.filter((s) => !s.error && s.excerpt.trim().length > 0);
        res.scrapedSources = usable;
        if (usable.length > 0) {
          const excerptBlock = usable
            .map((s) => {
              const compactExcerpt = s.excerpt.replace(/\n{3,}/g, '\n\n').trim();
              return `### ${s.title || s.url}\nURL: ${s.url}\n\n${compactExcerpt}`;
            })
            .join('\n\n---\n\n');
          return {
            ok: true,
            data: res,
            formatted: `${formattedResults}\n\n## Top Source Excerpts\n\n${excerptBlock}`,
          };
        }
      }
    }

    return { ok: true, data: res, formatted: formattedResults };
  }

  async fetchBackgroundTab(
    options: FetchBackgroundAdapterOptions,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<FetchedSourceResult[]>> {
    const granted = await this.checkHostPermission();
    if (!granted) {
      return {
        ok: false,
        needsPermission: true,
        error: 'Optional host permission (https://*/*) is required for fetch_background_tab.',
      };
    }

    const fetcherDeps: UrlFetcherDeps = {
      hasPermission: async () => true,
      fetchFn: this.options.fetchFn,
      openHiddenTabAndExtract: this.options.openHiddenTabAndExtract,
    };

    const sources = await runFetchAndReadUrls(options.urls, {
      query: options.query,
      maxCharsPerSource: options.max_chars,
      onSourceReady: this.options.onSourceReady,
      deps: fetcherDeps,
    });

    const anySuccess = sources.some((s) => !s.error && s.excerpt.length > 0);
    const captchaBlocked = sources.find((s) => s.blockedByCaptcha);
    const formatted = sources
      .map((s) => {
        if (s.error) {
          return `### ${s.url}\nError: ${s.error}${s.manualUrl ? ` (Manual URL: ${s.manualUrl})` : ''}`;
        }
        const compactExcerpt = s.excerpt.replace(/\n{3,}/g, '\n\n').trim();
        return `### ${s.title || s.url}\nURL: ${s.url}\n\n${compactExcerpt}`;
      })
      .join('\n\n---\n\n');

    return {
      ok: anySuccess,
      data: sources,
      formatted,
      ...(captchaBlocked && !anySuccess
        ? {
            blockedByCaptcha: true,
            manualUrl: captchaBlocked.manualUrl,
            error: captchaBlocked.error,
          }
        : !anySuccess
          ? { error: sources[0]?.error ?? 'Failed to fetch background source.' }
          : {}),
    };
  }
}

export type { ChromiumSerpResponse };
