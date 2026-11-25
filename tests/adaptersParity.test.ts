import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';
import {
  ChromeExtensionAdapter,
  InMemoryMemoryProvider,
  WebDemoAdapter,
  createToolRuntime,
  type ChromeApiBindings,
} from '../src/adapters/index.js';
import type { ExtractedPageContent, InteractPageInput, PageExtractMode } from '../src/types.js';
import { extractFromDocument } from '../src/extractors/pageExtractor.js';
import { executePageInteraction, formatInteractResult } from '../src/actions/interactPage.js';

const DEMO_HTML = `
  <!doctype html>
  <html>
    <head><title>Yours Demo Workspace</title></head>
    <body>
      <main>
        <h1>Local Inference</h1>
        <p>Zero external network requests by default.</p>
        <label for="prompt">Prompt</label>
        <input id="prompt" type="text" />
        <button id="go" type="button">Run Model</button>
        <div id="out">Waiting</div>
      </main>
    </body>
  </html>
`;

function createMockDom() {
  const dom = new JSDOM(DEMO_HTML, { url: 'https://yours.sh/demo' });
  const doc = dom.window.document;
  doc.getElementById('go')!.addEventListener('click', () => {
    const val = (doc.getElementById('prompt') as HTMLInputElement).value;
    doc.getElementById('out')!.textContent = `Output: ${val}`;
  });
  return dom;
}

function createMockChromeBindings(dom: JSDOM, permissionGranted: boolean): ChromeApiBindings {
  const tabs = [
    { id: 101, title: dom.window.document.title, url: 'https://yours.sh/demo', active: true, windowId: 1 },
    { id: 102, title: 'Docs', url: 'https://yours.sh/docs', active: false, windowId: 1 },
  ];

  return {
    tabs: {
      async query(info) {
        if (info.active) return tabs.filter((t) => t.active);
        return tabs;
      },
    },
    permissions: {
      async contains() {
        return permissionGranted;
      },
      async request() {
        return permissionGranted;
      },
    },
    scripting: {
      async executeScript({ func, args }) {
        // Execute against our JSDOM document cleanly to simulate MV3 tab execution
        const fnName = func.name;
        if (fnName === 'inPageSemanticExtractScript') {
          const extracted = extractFromDocument(dom.window.document, { mode: 'aom', maxChars: 16000 });
          return [{ result: extracted.semanticSnapshot as never }];
        }
        if (fnName === 'inPageExtractScript') {
          const [mode, maxChars, includeLinks] = (args ?? ['auto', 24000, false]) as [
            PageExtractMode,
            number,
            boolean,
          ];
          const extracted: ExtractedPageContent = extractFromDocument(dom.window.document, {
            mode,
            maxChars,
            includeLinks,
          });
          return [{ result: extracted as never }];
        }
        if (fnName === 'inPageInteractScript') {
          const [input] = (args ?? []) as unknown as [InteractPageInput];
          const outcome = await executePageInteraction(dom.window.document, input, { settleMs: 10 });
          if (outcome.ok && outcome.result) {
            formatInteractResult(outcome.result);
          }
          return [{ result: outcome as never }];
        }
        return [{ result: undefined }];
      },
    },
  };
}

describe('Dual-Adapter Parity: ChromeExtensionAdapter <-> WebDemoAdapter', () => {
  it('executes all 10 canonical tools & legacy aliases with identical semantics across MV3 and WebDemo', async () => {
    const chromeDom = createMockDom();
    const webDom = createMockDom();

    const mockFetch = (async (url: string) => {
      if (url.includes('duckduckgo.com')) {
        return new Response(
          `<a class="result__a" href="https://yours.sh/sdk">Yours SDK</a><a class="result__snippet">Unified browser tools</a>`,
          { status: 200, headers: { 'content-type': 'text/html' } },
        );
      }
      return new Response(
        `<html><head><title>Yours SDK</title></head><body><main><h1>SDK</h1><p>Unified browser tools for MV3 and web demos.</p></main></body></html>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as typeof fetch;

    const chromeAdapter = new ChromeExtensionAdapter({
      chromeApi: createMockChromeBindings(chromeDom, true),
      fetchFn: mockFetch,
    });

    const webAdapter = new WebDemoAdapter({
      initialTabs: [
        { id: 101, url: 'https://yours.sh/demo', active: true, windowId: 1, document: webDom.window.document },
        { id: 102, title: 'Docs', url: 'https://yours.sh/docs', active: false, windowId: 1, html: '<html><head><title>Docs</title></head><body><p>Reference</p></body></html>' },
      ],
      parseHtml: (html, url) => new JSDOM(html, { url }).window.document,
      allowNetwork: true,
      fetchFn: mockFetch,
    });

    const chromeRuntime = createToolRuntime(chromeAdapter, { memoryProvider: new InMemoryMemoryProvider() });
    const webRuntime = createToolRuntime(webAdapter, { memoryProvider: new InMemoryMemoryProvider() });

    for (const runtime of [chromeRuntime, webRuntime]) {
      // 1. list_tabs + legacy alias list_open_tabs
      const tabsRes = await runtime.execute({ name: 'list_open_tabs', arguments: {} });
      expect(tabsRes.ok).toBe(true);
      expect(tabsRes.toolName).toBe('list_tabs');
      expect(tabsRes.tainted).toBe(true);
      expect(tabsRes.formatted).toContain('Yours Demo Workspace');

      // 2. read_active_tab (aom) + legacy read_active_page
      const activeAom = await runtime.execute({
        name: 'read_active_page',
        arguments: { mode: 'aom' },
      });
      expect(activeAom.ok).toBe(true);
      expect(activeAom.toolName).toBe('read_active_tab');
      expect(activeAom.tainted).toBe(true);
      expect(activeAom.sourceOrigin).toBe('https://yours.sh');
      expect(activeAom.formatted).toContain('Prompt');

      // 3. read_tab
      const tabRead = await runtime.execute({ name: 'read_tab', arguments: { tabId: 101 } });
      expect(tabRead.ok).toBe(true);
      expect(tabRead.toolName).toBe('read_tab');

      // 4. interact_page (type + click)
      const typeRes = await runtime.execute({
        name: 'interact_page',
        arguments: { action: 'type', node_id: 1, text: 'hello pragma' },
      });
      expect(typeRes.ok).toBe(true);
      expect(typeRes.tainted).toBe(true);

      const clickRes = await runtime.execute({
        name: 'interact_page',
        arguments: { action: 'click', node_id: 2 },
      });
      expect(clickRes.ok).toBe(true);
      expect(clickRes.formatted).toContain('Output: hello pragma');

      // 5. run_sandbox + legacy js_calc
      const calcRes = await runtime.execute({
        name: 'js_calc',
        arguments: { expression: '2 ^ 10' },
      });
      expect(calcRes.ok).toBe(true);
      expect(calcRes.toolName).toBe('run_sandbox');
      expect(calcRes.tainted).toBe(false);
      expect(calcRes.formatted).toBe('1024');

      // 6. read_document
      const docRes = await runtime.execute({
        name: 'read_document',
        arguments: { source: 'colA,colB\n1,2\n3,4', format: 'csv' },
      });
      expect(docRes.ok).toBe(true);
      expect(docRes.toolName).toBe('read_document');
      expect(docRes.tainted).toBe(true);

      // 7. search_web_tab + legacy web_search
      const searchRes = await runtime.execute({
        name: 'web_search',
        arguments: { query: 'yours sdk', limit: 3 },
      });
      expect(searchRes.ok).toBe(true);
      expect(searchRes.toolName).toBe('search_web_tab');
      expect(searchRes.tainted).toBe(true);
      expect(searchRes.formatted).toContain('Yours SDK');

      // 8. fetch_background_tab + legacy fetch_and_read_url
      const fetchRes = await runtime.execute({
        name: 'fetch_and_read_url',
        arguments: { urls: ['https://yours.sh/sdk'] },
      });
      expect(fetchRes.ok).toBe(true);
      expect(fetchRes.toolName).toBe('fetch_background_tab');
      expect(fetchRes.tainted).toBe(true);

      // 9. memory_save & memory_recall
      const saveRes = await runtime.execute({
        name: 'memory_save',
        arguments: { content: 'User prefers dark mode and WGSL tier1', tier: 'profile', tags: ['prefs'] },
      });
      expect(saveRes.ok).toBe(true);
      expect(saveRes.tainted).toBe(false);

      const recallRes = await runtime.execute({
        name: 'memory_recall',
        arguments: { query: 'dark mode WGSL' },
      });
      expect(recallRes.ok).toBe(true);
      expect(recallRes.tainted).toBe(false);
      expect(recallRes.formatted).toContain('WGSL tier1');
    }
  });

  it('fails closed on network tools when permissions are denied and handles non-Chrome environments safely', async () => {
    const bareChromeRuntime = createToolRuntime(new ChromeExtensionAdapter());
    const bareTabs = await bareChromeRuntime.execute({ name: 'list_tabs', arguments: {} });
    expect(bareTabs.ok).toBe(false);
    expect(bareTabs.error).toContain('unavailable');

    const deniedSearch = await bareChromeRuntime.execute({
      name: 'search_web_tab',
      arguments: { query: 'test' },
    });
    expect(deniedSearch.ok).toBe(false);
    expect(deniedSearch.needsPermission).toBe(true);

    const lockedWebRuntime = createToolRuntime(new WebDemoAdapter());
    const lockedFetch = await lockedWebRuntime.execute({
      name: 'fetch_background_tab',
      arguments: { url: 'https://yours.sh' },
    });
    expect(lockedFetch.ok).toBe(false);
    expect(lockedFetch.needsPermission).toBe(true);
  });
});
