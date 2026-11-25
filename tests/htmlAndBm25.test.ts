import { describe, expect, it } from 'vitest';
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
});
