import { describe, expect, it, vi } from 'vitest';
import {
  distillHtmlToMarkdown,
  extractYouTubeCaptionTrack,
  parseYouTubeTranscriptXml,
} from '../src/extractors/htmlDistiller.js';
import { rankPassagesBm25 } from '../src/search/bm25Ranker.js';
import {
  detectAntiBotChallenge,
  parseBingWebHtmlResults,
  parseDuckDuckGoHtmlResults,
  parseStartpageHtmlResults,
  runWebSearch,
} from '../src/search/webSearch.js';

describe('HTML->Markdown Distiller, BM25 Ranker, and SERP Parsers', () => {
  it('distills article HTML to clean markdown while stripping boilerplate & cookie banners', () => {
    const html = `
      <html>
        <head><title>Local AI Guide</title></head>
        <body>
          <nav><a href="/home">Home</a></nav>
          <div class="cookie-banner">Accept cookies please</div>
          <article>
            <h1>WebGPU Inference</h1>
            <p>Running <strong>4B models</strong> in Chromium with <a href="/docs">WGSL</a>.</p>
            <pre><code class="language-ts">const x = 1;</code></pre>
            <table>
              <tr><th>Backend</th><th>Speed</th></tr>
              <tr><td>WGSL</td><td>45 tok/s</td></tr>
            </table>
          </article>
          <footer>Copyright 2026</footer>
        </body>
      </html>
    `;

    const distilled = distillHtmlToMarkdown(html, {
      baseUrl: 'https://yours.sh/blog/post',
      includeLinks: true,
    });
    expect(distilled.title).toBe('Local AI Guide');
    expect(distilled.markdown).toContain('# WebGPU Inference');
    expect(distilled.markdown).toContain('**4B models**');
    expect(distilled.markdown).toContain('[WGSL](https://yours.sh/docs)');
    expect(distilled.markdown).toContain('```ts\nconst x = 1;\n```');
    expect(distilled.markdown).toContain('| WGSL | 45 tok/s |');
    expect(distilled.markdown).not.toContain('Accept cookies');
    expect(distilled.markdown).not.toContain('Copyright 2026');
  });

  it('extracts YouTube caption tracks and parses double-encoded transcript XML', () => {
    const ytHtml = `
      <html><head><title>WGSL Demo - YouTube</title></head>
      <body><script>var ytInitialPlayerResponse = {"videoDetails":{"title":"WGSL Demo"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=123\\u0026lang=en","languageCode":"en"}]}}};</script></body>
      </html>
    `;
    const track = extractYouTubeCaptionTrack(ytHtml);
    expect(track).toEqual({
      title: 'WGSL Demo',
      captionBaseUrl: 'https://www.youtube.com/api/timedtext?v=123&lang=en',
      languageCode: 'en',
    });

    const xml = '<transcript><text start="65.2">Hello &amp;#39;world&amp;#39;</text></transcript>';
    expect(parseYouTubeTranscriptXml(xml)).toBe("[01:05] Hello 'world'");
  });

  it('ranks relevant markdown passages first with BM25 under tight budget', () => {
    const md = [
      '# Overview\n\nIntroductory notes about browser extensions.',
      '## Gardening\n\nTomatoes need sunlight and water every morning.',
      '## WGSL Kernels\n\nSubgroup f16 matrix multiplication accelerates token generation in WebGPU.',
      '## Cooking\n\nBoil pasta for eight minutes with salt.',
    ].join('\n\n');

    const ranked = rankPassagesBm25(md, 'WGSL subgroup WebGPU', 180);
    expect(ranked.excerpt).toContain('Subgroup f16 matrix multiplication');
    expect(ranked.excerpt).not.toContain('Tomatoes');
    expect(ranked.topScore).toBeGreaterThan(0);
  });

  it('parses DuckDuckGo, Bing, and Startpage SERPs and detects CAPTCHAs without bypassing', () => {
    const ddg = `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fyours.sh%2F">Yours Research</a><a class="result__snippet">Local AI SDK</a>`;
    expect(parseDuckDuckGoHtmlResults(ddg, 5)[0]).toMatchObject({
      title: 'Yours Research',
      url: 'https://yours.sh/',
      domain: 'yours.sh',
    });

    const bingUrl = `https://www.bing.com/ck/a?u=a1${Buffer.from('https://yours.sh/docs').toString('base64url')}`;
    const bing = `<li class="b_algo"><h2><a href="${bingUrl}">Docs</a></h2><p class="b_algoSlug">API reference</p></li>`;
    expect(parseBingWebHtmlResults(bing, 5)[0]).toMatchObject({
      title: 'Docs',
      url: 'https://yours.sh/docs',
    });

    const sp = `<a class="w-gl__result-title" href="https://yours.sh/blog">Blog</a><p class="w-gl__description">Release notes</p>`;
    expect(parseStartpageHtmlResults(sp, 5)[0]).toMatchObject({
      title: 'Blog',
      url: 'https://yours.sh/blog',
    });

    expect(detectAntiBotChallenge('<html>Please verify you are human</html>', 200)).toBe(true);
    expect(detectAntiBotChallenge('<div class="cf-turnstile"></div>', 403)).toBe(true);
    expect(detectAntiBotChallenge('<html><body><p>Normal page content</p></body></html>', 200)).toBe(false);
  });

  it('runWebSearch tries headless DuckDuckGo HTML before searchViaChromiumSerp and avoids opening tabs', async () => {
    const calledUrls: string[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calledUrls.push(url);
      return new Response(
        `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fyours.sh%2Fwebgpu">Yours WebGPU</a><a class="result__snippet">Local WebGPU inference SDK</a>`,
        { status: 200, headers: { 'content-type': 'text/html' } },
      );
    }) as unknown as typeof fetch;

    const searchViaChromiumSerp = vi.fn(async () => ({
      ok: true,
      engine: 'bing' as const,
      query: 'webgpu',
      results: [{ title: 'Should not run', url: 'https://example.com', snippet: 'unused', domain: 'example.com' }],
      elapsedMs: 10,
    }));
    const openHiddenTabAndExtract = vi.fn(async () => ({ html: '' }));

    const res = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      fetchFn,
      searchViaChromiumSerp,
      openHiddenTabAndExtract,
    });

    expect(res.ok).toBe(true);
    expect(res.engine).toBe('ddg');
    expect(res.fromHiddenTab).toBe(false);
    expect(res.results).toHaveLength(1);
    expect(res.results[0].url).toBe('https://yours.sh/webgpu');
    expect(calledUrls).toEqual(['https://html.duckduckgo.com/html/?q=webgpu']);
    expect(searchViaChromiumSerp).not.toHaveBeenCalled();
    expect(openHiddenTabAndExtract).not.toHaveBeenCalled();
  });

  it('runWebSearch falls back from html.duckduckgo.com to lite.duckduckgo.com seamlessly', async () => {
    const calledUrls: string[] = [];
    const anomalyFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calledUrls.push(url);
      if (url.includes('html.duckduckgo.com')) {
        return new Response('<script src="https://duckduckgo.com/anomaly.js"></script>', { status: 202 });
      }
      return new Response(
        `<table><tr><td><a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fyours.sh%2Flite">Lite Result</a></td></tr><tr><td class="result-snippet">Fast text SERP</td></tr></table>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const searchViaChromiumSerp = vi.fn(async () => ({
      ok: true,
      engine: 'bing' as const,
      query: 'webgpu',
      results: [],
      elapsedMs: 5,
    }));

    const res = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      fetchFn: anomalyFetch,
      searchViaChromiumSerp,
    });

    expect(res.ok).toBe(true);
    expect(res.engine).toBe('ddg');
    expect(res.fromHiddenTab).toBe(false);
    expect(res.results[0]).toMatchObject({
      title: 'Lite Result',
      url: 'https://yours.sh/lite',
      snippet: 'Fast text SERP',
    });
    expect(calledUrls).toEqual([
      'https://html.duckduckgo.com/html/?q=webgpu',
      'https://lite.duckduckgo.com/lite/?q=webgpu',
    ]);
    expect(searchViaChromiumSerp).not.toHaveBeenCalled();

    const networkErrorFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('html.duckduckgo.com')) {
        throw new Error('network error');
      }
      return new Response(
        `<a class="result-link" href="https://yours.sh/recovered">Recovered Lite</a><td class="result-snippet">Recovered snippet</td>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const recovered = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      fetchFn: networkErrorFetch,
      searchViaChromiumSerp,
    });

    expect(recovered.ok).toBe(true);
    expect(recovered.engine).toBe('ddg');
    expect(recovered.fromHiddenTab).toBe(false);
    expect(recovered.results[0].url).toBe('https://yours.sh/recovered');
    expect(searchViaChromiumSerp).not.toHaveBeenCalled();
  });

  it('runWebSearch surfaces blockedByCaptcha and manualUrl when both HTML and Lite hit anti-bot gates', async () => {
    const captchaFetch = vi.fn(async () => {
      return new Response('<div class="g-recaptcha"></div>', { status: 403 });
    }) as unknown as typeof fetch;

    const res = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      fetchFn: captchaFetch,
    });

    expect(res.ok).toBe(false);
    expect(res.blockedByCaptcha).toBe(true);
    expect(res.manualUrl).toContain('duckduckgo.com');
    expect(res.results).toEqual([]);
    expect(captchaFetch).toHaveBeenCalledTimes(2);

    const blockedSerp = vi.fn(async (query: string) => ({
      ok: false,
      engine: 'bing' as const,
      query,
      results: [],
      elapsedMs: 25,
      blockedByCaptcha: true,
      manualUrl: 'https://www.bing.com/search?q=webgpu',
      error: 'Bing CAPTCHA',
    }));

    const bothBlocked = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      fetchFn: captchaFetch,
      searchViaChromiumSerp: blockedSerp,
    });
    expect(bothBlocked.ok).toBe(false);
    expect(bothBlocked.blockedByCaptcha).toBe(true);
    expect(bothBlocked.manualUrl).toBe('https://www.bing.com/search?q=webgpu');
  });

  it('runWebSearch falls back to searchViaChromiumSerp when headless DDG returns 0 results and honors preferHeadlessFetch: false', async () => {
    const calledUrls: string[] = [];
    const emptyFetch = vi.fn(async (input: RequestInfo | URL) => {
      calledUrls.push(String(input));
      return new Response('<html><body>No results</body></html>', { status: 200 });
    }) as unknown as typeof fetch;

    const searchViaChromiumSerp = vi.fn(async (query: string) => ({
      ok: true,
      engine: 'bing' as const,
      query,
      results: [
        {
          title: 'Chromium SERP Fallback',
          url: 'https://yours.sh/chromium',
          snippet: 'Returned from Bing tab',
          domain: 'yours.sh',
        },
      ],
      elapsedMs: 42,
    }));

    const fallbackRes = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      fetchFn: emptyFetch,
      searchViaChromiumSerp,
    });

    expect(calledUrls).toEqual([
      'https://html.duckduckgo.com/html/?q=webgpu',
      'https://lite.duckduckgo.com/lite/?q=webgpu',
    ]);
    expect(searchViaChromiumSerp).toHaveBeenCalledTimes(1);
    expect(fallbackRes.ok).toBe(true);
    expect(fallbackRes.engine).toBe('bing');
    expect(fallbackRes.fromHiddenTab).toBe(true);
    expect(fallbackRes.results[0].url).toBe('https://yours.sh/chromium');

    const skippedFetch = vi.fn() as unknown as typeof fetch;
    const directSerp = vi.fn(async (query: string) => ({
      ok: true,
      engine: 'startpage' as const,
      query,
      results: [
        {
          title: 'Direct Chromium SERP',
          url: 'https://yours.sh/direct',
          snippet: 'Headless disabled',
          domain: 'yours.sh',
        },
      ],
      elapsedMs: 18,
    }));

    const disabledHeadlessRes = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      preferHeadlessFetch: false,
      fetchFn: skippedFetch,
      searchViaChromiumSerp: directSerp,
    });

    expect(skippedFetch).not.toHaveBeenCalled();
    expect(directSerp).toHaveBeenCalledTimes(1);
    expect(disabledHeadlessRes.ok).toBe(true);
    expect(disabledHeadlessRes.engine).toBe('startpage');
    expect(disabledHeadlessRes.fromHiddenTab).toBe(true);
  });

  it('runWebSearch supports defaultEngine ordering (bing / startpage) and fails closed without permission', async () => {
    const deniedFetch = vi.fn() as unknown as typeof fetch;
    const denied = await runWebSearch('webgpu', 5, { fetchFn: deniedFetch });
    expect(denied.ok).toBe(false);
    expect(denied.needsPermission).toBe(true);
    expect(deniedFetch).not.toHaveBeenCalled();

    const bingUrls: string[] = [];
    const bingUrl = `https://www.bing.com/ck/a?u=a1${Buffer.from('https://yours.sh/bing').toString('base64url')}`;
    const bingFetch = vi.fn(async (input: RequestInfo | URL) => {
      bingUrls.push(String(input));
      return new Response(
        `<li class="b_algo"><h2><a href="${bingUrl}">Bing Result</a></h2><p class="b_algoSlug">Bing snippet</p></li>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const bingRes = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      defaultEngine: 'bing',
      fetchFn: bingFetch,
    });
    expect(bingUrls).toEqual(['https://www.bing.com/search?q=webgpu']);
    expect(bingRes.ok).toBe(true);
    expect(bingRes.engine).toBe('bing');
    expect(bingRes.fromHiddenTab).toBe(false);
    expect(bingRes.results[0].url).toBe('https://yours.sh/bing');

    const spUrls: string[] = [];
    const spFetch = vi.fn(async (input: RequestInfo | URL) => {
      spUrls.push(String(input));
      return new Response(
        `<a class="w-gl__result-title" href="https://yours.sh/sp">Startpage Result</a><p class="w-gl__description">SP snippet</p>`,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const spRes = await runWebSearch('webgpu', 5, {
      hasPermission: async () => true,
      defaultEngine: 'startpage',
      fetchFn: spFetch,
    });
    expect(spUrls).toEqual(['https://www.startpage.com/sp/search?query=webgpu']);
    expect(spRes.ok).toBe(true);
    expect(spRes.engine).toBe('startpage');
    expect(spRes.fromHiddenTab).toBe(false);
    expect(spRes.results[0].url).toBe('https://yours.sh/sp');
  });
});
