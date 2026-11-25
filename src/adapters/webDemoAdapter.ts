import { executePageInteraction, formatInteractResult, type InteractPageOptions } from '../actions/interactPage.js';
import { readDocument } from '../documents/documentReader.js';
import { distillHtmlToMarkdown } from '../extractors/htmlDistiller.js';
import { extractFromDocument } from '../extractors/pageExtractor.js';
import { runSandbox } from '../sandbox/sandbox.js';
import { runFetchAndReadUrls } from '../search/urlFetcher.js';
import { runWebSearch, type WebSearchDeps } from '../search/webSearch.js';
import type {
  DocumentFormat,
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
  ToolInvocationContext,
  WebSearchResult,
} from '../types.js';
import type {
  AdapterOutcome,
  FetchBackgroundAdapterOptions,
  ReadPageAdapterOptions,
  SearchWebAdapterOptions,
  ToolHostAdapter,
} from './types.js';

export interface VirtualTabInit {
  id?: number;
  title?: string;
  url: string;
  active?: boolean;
  windowId?: number;
  document?: Document;
  html?: string;
}

interface InternalVirtualTab {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
  document?: Document;
  html?: string;
}

export interface WebDemoAdapterOptions {
  /** Initial active/background virtual tabs for the web demo workspace. */
  initialTabs?: VirtualTabInit[];
  /** Optional HTML-to-DOM parser (defaults to browser `DOMParser` when available). */
  parseHtml?: (html: string, url: string) => Document;
  /** Optional policy gate for network tools (`search_web_tab`, `fetch_background_tab`). Defaults to false (fail-closed). */
  allowNetwork?: boolean | (() => Promise<boolean>);
  /** Optional fetch implementation for network tools when `allowNetwork` is enabled. */
  fetchFn?: typeof fetch;
  /** Optional custom SERP provider for web demos. */
  searchViaSerp?: WebSearchDeps['searchViaChromiumSerp'];
  /** Optional hidden-tab/iframe extractor for web demos. */
  openHiddenTabAndExtract?: (url: string) => Promise<HiddenTabHtmlResponse>;
  /** Optional local PDF extractor (e.g. pdfjs-dist worker). */
  pdfExtractor?: PdfBinaryExtractor;
  /** Optional QuickJS-WASM runtime adapter. */
  quickJsAdapter?: QuickJsRuntimeAdapter;
  /** Optional interaction options (settleMs, approval callback). */
  interactOptions?: InteractPageOptions;
}

/**
 * Web Demo Adapter implementing `ToolHostAdapter` for `yours.sh` browser demos and virtual workspaces
 * with 100% parity to `ChromeExtensionAdapter` and zero Chrome extension API dependencies.
 */
export class WebDemoAdapter implements ToolHostAdapter {
  readonly environment = 'web-demo' as const;
  private readonly tabs = new Map<number, InternalVirtualTab>();
  private readonly documents = new Map<
    string,
    { content: string; format?: DocumentFormat; filename?: string }
  >();
  private nextTabId = 1;
  private readonly options: WebDemoAdapterOptions;

  constructor(options: WebDemoAdapterOptions = {}) {
    this.options = options;
    if (options.initialTabs) {
      for (const tab of options.initialTabs) {
        this.openTab(tab);
      }
    }
  }

  /**
   * Opens or registers a virtual tab (from a live `Document`, `HTMLIFrameElement.contentDocument`, or raw HTML).
   */
  openTab(init: VirtualTabInit): OpenTabInfo {
    const id = init.id ?? this.nextTabId++;
    if (id >= this.nextTabId) this.nextTabId = id + 1;

    if (init.active || this.tabs.size === 0) {
      for (const existing of this.tabs.values()) {
        existing.active = false;
      }
    }

    const doc = init.document ?? (init.html ? this.tryParseHtml(init.html, init.url) : undefined);
    const title = init.title ?? doc?.title ?? '';

    const record: InternalVirtualTab = {
      id,
      title,
      url: init.url,
      active: init.active ?? this.tabs.size === 0,
      windowId: init.windowId ?? 1,
      document: doc,
      html: init.html,
    };
    this.tabs.set(id, record);
    return {
      id: record.id,
      title: record.title,
      url: record.url,
      active: record.active,
      windowId: record.windowId,
    };
  }

  setActiveTab(tabId: number): boolean {
    if (!this.tabs.has(tabId)) return false;
    for (const tab of this.tabs.values()) {
      tab.active = tab.id === tabId;
    }
    return true;
  }

  registerDocument(
    key: string,
    content: string,
    options?: { format?: DocumentFormat; filename?: string },
  ): void {
    this.documents.set(key, {
      content,
      format: options?.format,
      filename: options?.filename ?? key,
    });
  }

  private tryParseHtml(html: string, url: string): Document | undefined {
    if (this.options.parseHtml) {
      return this.options.parseHtml(html, url);
    }
    if (typeof DOMParser !== 'undefined') {
      const parser = new DOMParser();
      return parser.parseFromString(html, 'text/html');
    }
    return undefined;
  }

  private getTabDocument(tab: InternalVirtualTab): Document | undefined {
    if (tab.document) return tab.document;
    if (tab.html) {
      tab.document = this.tryParseHtml(tab.html, tab.url);
      return tab.document;
    }
    return undefined;
  }

  private async hasNetworkPermission(): Promise<boolean> {
    if (typeof this.options.allowNetwork === 'function') {
      return this.options.allowNetwork();
    }
    return Boolean(this.options.allowNetwork);
  }

  async listTabs(
    windowScope: 'current' | 'all',
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<OpenTabInfo[]>> {
    const all = Array.from(this.tabs.values());
    const activeWindowId = all.find((t) => t.active)?.windowId ?? 1;
    const filtered = windowScope === 'current' ? all.filter((t) => t.windowId === activeWindowId) : all;
    return {
      ok: true,
      data: filtered.map((t) => ({
        id: t.id,
        title: t.document?.title || t.title,
        url: t.document?.location?.href || t.url,
        active: t.active,
        windowId: t.windowId,
      })),
    };
  }

  async readActiveTab(
    options: ReadPageAdapterOptions,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ExtractedPageContent>> {
    const active = Array.from(this.tabs.values()).find((t) => t.active) ?? Array.from(this.tabs.values())[0];
    if (!active) {
      return { ok: false, error: 'No active virtual tab found in WebDemoAdapter.' };
    }
    return this.readTab(active.id, options, ctx);
  }

  async readTab(
    tabId: number,
    options: ReadPageAdapterOptions,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ExtractedPageContent>> {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      return { ok: false, error: `Virtual tab ${tabId} not found.` };
    }

    const doc = this.getTabDocument(tab);
    if (doc) {
      const extracted = extractFromDocument(doc, {
        mode: options.mode,
        maxChars: options.max_chars,
        includeLinks: options.include_links,
      });
      if (!extracted.url) extracted.url = tab.url;
      if (!extracted.title) extracted.title = tab.title;
      return { ok: true, data: extracted };
    }

    if (tab.html) {
      const distilled = distillHtmlToMarkdown(tab.html, {
        maxChars: options.max_chars,
        baseUrl: tab.url,
        includeLinks: options.include_links,
      });
      const content = distilled.markdown;
      return {
        ok: true,
        data: {
          mode: 'article',
          title: distilled.title || tab.title,
          url: tab.url,
          content,
          fullContent: content,
          links: distilled.links,
          contentHash: `${content.length.toString(16)}`,
          charCount: content.length,
          truncated: content.endsWith('… [truncated]'),
        },
      };
    }

    return { ok: false, error: `Virtual tab ${tabId} has no Document or HTML content.` };
  }

  async interactPage(
    input: InteractPageInput,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<InteractPageResult>> {
    const tab =
      input.tab_id !== undefined
        ? this.tabs.get(input.tab_id)
        : Array.from(this.tabs.values()).find((t) => t.active) ?? Array.from(this.tabs.values())[0];

    if (!tab) {
      return { ok: false, error: 'No target virtual tab found for interact_page.' };
    }

    const doc = this.getTabDocument(tab);
    if (!doc) {
      return {
        ok: false,
        error: `Virtual tab ${tab.id} has no live DOM Document (provide Document or parseHtml).`,
      };
    }

    const outcome = await executePageInteraction(doc, input, this.options.interactOptions);
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
    };
  }

  async readDocument(
    input: ReadDocumentInput,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ReadDocumentResult>> {
    const res = await readDocument(input, {
      pdfExtractor: this.options.pdfExtractor,
      documentRegistry: this.documents,
    });
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
    const res = await runSandbox(input, {
      quickJsAdapter: this.options.quickJsAdapter,
    });
    return {
      ok: res.ok,
      data: res,
      formatted: res.formatted,
      error: res.error,
    };
  }

  async searchWebTab(
    query: string,
    options: SearchWebAdapterOptions,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<WebSearchResult>> {
    const allowed = await this.hasNetworkPermission();
    if (!allowed) {
      return {
        ok: false,
        needsPermission: true,
        error: 'Network access is disabled by default in WebDemoAdapter (allowNetwork=false).',
      };
    }

    const res = await runWebSearch(query, options.max_results, {
      hasPermission: async () => true,
      searchViaChromiumSerp: this.options.searchViaSerp,
      fetchFn: this.options.fetchFn,
      openHiddenTabAndExtract: this.options.openHiddenTabAndExtract,
    });

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

    const formatted = res.results
      .map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`)
      .join('\n\n');

    return { ok: true, data: res, formatted };
  }

  async fetchBackgroundTab(
    options: FetchBackgroundAdapterOptions,
    _ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<FetchedSourceResult[]>> {
    const allowed = await this.hasNetworkPermission();
    if (!allowed) {
      return {
        ok: false,
        needsPermission: true,
        error: 'Network access is disabled by default in WebDemoAdapter (allowNetwork=false).',
      };
    }

    const sources = await runFetchAndReadUrls(options.urls, {
      query: options.query,
      maxCharsPerSource: options.max_chars,
      deps: {
        hasPermission: async () => true,
        fetchFn: this.options.fetchFn,
        openHiddenTabAndExtract: this.options.openHiddenTabAndExtract,
      },
    });

    const anySuccess = sources.some((s) => !s.error && s.excerpt.length > 0);
    const captchaBlocked = sources.find((s) => s.blockedByCaptcha);
    const formatted = sources
      .map((s) =>
        s.error
          ? `### ${s.url}\nError: ${s.error}${s.manualUrl ? ` (Manual URL: ${s.manualUrl})` : ''}`
          : `### ${s.title || s.url}\nURL: ${s.url}\n\n${s.excerpt}`,
      )
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
