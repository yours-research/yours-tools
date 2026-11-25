import type { ExtractedPageContent, PageExtractMode } from '../types.js';
import { extractSemanticSnapshot } from './semanticAom.js';

function fnv1aHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function truncateClean(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  if (limit <= 0) {
    return { text: '', truncated: text.length > 0 };
  }
  const slice = text.slice(0, limit);
  const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  const cutoff = lastBreak > limit * 0.65 ? lastBreak : limit;
  return {
    text: `${slice.slice(0, cutoff).trimEnd()}\n… [truncated]`,
    truncated: true,
  };
}

function extractDocumentMetadata(doc: Document): Record<string, string> {
  const meta: Record<string, string> = {};
  const pick = (key: string, val: unknown) => {
    if (meta[key] || typeof val !== 'string') return;
    const clean = val.replace(/\s+/g, ' ').trim();
    if (clean && clean.length <= 320) meta[key] = clean;
  };

  for (const m of Array.from(doc.querySelectorAll('meta[name], meta[property]'))) {
    const k = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
    const v = m.getAttribute('content') || '';
    if (!v) continue;
    if (k === 'author' || k === 'article:author') pick('author', v);
    else if (k === 'article:published_time' || k === 'date' || k === 'pubdate') pick('published', v);
    else if (k === 'og:site_name') pick('site', v);
    else if (k === 'description' || k === 'og:description') pick('description', v);
  }

  for (const s of Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).slice(0, 6)) {
    const raw = (s.textContent ?? '').trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.author === 'string') pick('author', parsed.author);
      else if (parsed.author && typeof parsed.author === 'object') {
        pick('author', (parsed.author as Record<string, unknown>).name);
      }
      if (typeof parsed.datePublished === 'string') pick('published', parsed.datePublished);
      if (typeof parsed.description === 'string') pick('description', parsed.description);
    } catch {
      // Ignore malformed JSON-LD
    }
  }

  return meta;
}

/**
 * Extracts clean markdown, semantic AOM snapshot, selection, PDF textLayer, or YouTube captions
 * directly from any DOM `Document` (browser, iframe, or JSDOM).
 */
export function extractFromDocument(
  doc: Document,
  options?: {
    mode?: PageExtractMode;
    maxChars?: number;
    includeLinks?: boolean;
  },
): ExtractedPageContent {
  const mode: PageExtractMode = options?.mode ?? 'auto';
  const safeMaxChars =
    typeof options?.maxChars === 'number' && options.maxChars > 0 ? options.maxChars : 24000;
  const includeLinks = options?.includeLinks ?? false;

  const pageTitle = (doc.title || '').replace(/\s+/g, ' ').trim();
  const pageUrl = doc.location?.href || doc.URL || '';
  const metadata = extractDocumentMetadata(doc);
  const win = doc.defaultView;

  const rawSelectionText = (win?.getSelection?.()?.toString() ?? '').trim();

  if (mode === 'selection' || (mode === 'auto' && rawSelectionText.length >= 10)) {
    const { text, truncated } = truncateClean(rawSelectionText, safeMaxChars);
    return {
      mode: 'selection',
      title: pageTitle,
      url: pageUrl,
      content: text,
      fullContent: rawSelectionText,
      selectionText: rawSelectionText,
      metadata,
      contentHash: fnv1aHash(rawSelectionText),
      charCount: rawSelectionText.length,
      truncated,
    };
  }

  if (mode === 'aom' || mode === 'interactive') {
    const { snapshot } = extractSemanticSnapshot(doc, {
      maxChars: safeMaxChars,
      includeLinks,
    });
    const { text, truncated } = truncateClean(snapshot.compactText, safeMaxChars);
    return {
      mode: mode === 'interactive' ? 'interactive' : 'aom',
      title: pageTitle,
      url: pageUrl,
      content: text,
      fullContent: snapshot.compactText,
      outline: snapshot.outline,
      viewportExcerpt: snapshot.viewportExcerpt,
      metadata,
      semanticSnapshot: snapshot,
      contentHash: fnv1aHash(snapshot.compactText),
      charCount: snapshot.compactText.length,
      truncated,
    };
  }

  // YouTube transcript check
  const host = (doc.location?.hostname ?? '').toLowerCase();
  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    const segments = Array.from(doc.querySelectorAll('ytd-transcript-segment-renderer'));
    if (segments.length > 0) {
      const segLines: string[] = [];
      for (const seg of segments) {
        const ts = (seg.querySelector('.segment-timestamp')?.textContent ?? '').trim();
        const txt = (seg.querySelector('.segment-text')?.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (txt) segLines.push(ts ? `[${ts}] ${txt}` : txt);
      }
      const inlineTranscript = segLines.join('\n');
      if (inlineTranscript) {
        const { text, truncated } = truncateClean(inlineTranscript, safeMaxChars);
        return {
          mode: 'youtube',
          title: pageTitle.replace(/\s*-\s*YouTube$/i, '').trim(),
          url: pageUrl,
          content: text,
          fullContent: inlineTranscript,
          metadata,
          contentHash: fnv1aHash(inlineTranscript),
          charCount: inlineTranscript.length,
          truncated,
        };
      }
    }
  }

  // PDF.js .textLayer check
  const textLayers = Array.from(doc.querySelectorAll('.textLayer'));
  if (textLayers.length > 0) {
    const pdfText = textLayers
      .map((l) => (l.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n\n');
    if (pdfText.length >= 30) {
      const { text, truncated } = truncateClean(pdfText, safeMaxChars);
      return {
        mode: 'pdf',
        title: pageTitle,
        url: pageUrl,
        content: text,
        fullContent: pdfText,
        metadata,
        contentHash: fnv1aHash(pdfText),
        charCount: pdfText.length,
        truncated,
      };
    }
  }

  // Default article extraction backed by semantic AOM + clean text blocks
  const { snapshot } = extractSemanticSnapshot(doc, {
    maxChars: Math.max(safeMaxChars, 32000),
    includeLinks,
  });

  const links: Array<{ text: string; url: string }> = [];
  if (includeLinks) {
    const seen = new Set<string>();
    for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
      const href = (a.getAttribute('href') ?? '').trim();
      const label = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!label || !href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) {
        continue;
      }
      let abs = href;
      if (pageUrl) {
        try {
          abs = new URL(href, pageUrl).toString();
        } catch {
          continue;
        }
      }
      if (!seen.has(abs)) {
        seen.add(abs);
        links.push({ text: label, url: abs });
      }
    }
  }

  const bodyRoot = doc.querySelector('article, main, [role="main"]') ?? doc.body ?? doc.documentElement;
  const paragraphs: string[] = [];
  if (bodyRoot) {
    for (const node of Array.from(bodyRoot.querySelectorAll('h1, h2, h3, h4, p, li, blockquote, pre, tr'))) {
      if (node.closest('nav, footer, aside, script, style, noscript')) continue;
      const style = (node.getAttribute('style') ?? '').toLowerCase();
      if (/display\s*:\s*none|visibility\s*:\s*hidden/.test(style)) continue;
      if ((node as HTMLElement).hidden || node.getAttribute('aria-hidden') === 'true') continue;
      const tag = node.tagName.toLowerCase();
      const txt = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      if (/^h[1-4]$/.test(tag)) {
        paragraphs.push(`${'#'.repeat(Number(tag[1]))} ${txt}`);
      } else if (tag === 'li') {
        paragraphs.push(`- ${txt}`);
      } else if (tag === 'blockquote') {
        paragraphs.push(`> ${txt}`);
      } else if (tag === 'pre') {
        paragraphs.push(`\`\`\`\n${(node.textContent ?? '').trim()}\n\`\`\``);
      } else if (!paragraphs.includes(txt)) {
        paragraphs.push(txt);
      }
    }
  }

  const metaPairs = Object.entries(metadata).map(([k, v]) => `- ${k}: ${v}`);
  const metaBlock = metaPairs.length > 0 ? `## Metadata\n${metaPairs.join('\n')}` : '';
  const bodyMarkdown = paragraphs.join('\n\n').trim() || snapshot.compactText;
  const linksBlock =
    includeLinks && links.length > 0
      ? `## Links\n${links.slice(0, 40).map((l) => `- [${l.text}](${l.url})`).join('\n')}`
      : '';
  const fullRaw = [metaBlock, bodyMarkdown, linksBlock].filter(Boolean).join('\n\n').trim();
  const { text, truncated } = truncateClean(fullRaw, safeMaxChars);

  return {
    mode: 'article',
    title: pageTitle,
    url: pageUrl,
    content: text,
    fullContent: fullRaw,
    outline: snapshot.outline,
    viewportExcerpt: snapshot.viewportExcerpt,
    selectionText: rawSelectionText || undefined,
    metadata,
    ...(includeLinks ? { links } : {}),
    semanticSnapshot: snapshot,
    contentHash: fnv1aHash(fullRaw),
    charCount: fullRaw.length,
    truncated,
  };
}

/**
 * Self-contained page extraction function injected via `chrome.scripting.executeScript`.
 * IMPORTANT: Never references outer-scope imports, helpers, or variables.
 */
export function inPageExtractScript(
  mode: PageExtractMode,
  maxChars: number,
  includeLinks = false,
): ExtractedPageContent {
  const fnv1aHashLocal = (input: string): string => {
    let hash = 0x811c9dc5;
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  };

  const truncateLocal = (text: string, limit: number): { text: string; truncated: boolean } => {
    if (text.length <= limit) return { text, truncated: false };
    if (limit <= 0) return { text: '', truncated: text.length > 0 };
    const slice = text.slice(0, limit);
    const lastBreak = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const cutoff = lastBreak > limit * 0.65 ? lastBreak : limit;
    return { text: `${slice.slice(0, cutoff).trimEnd()}\n… [truncated]`, truncated: true };
  };

  const pageTitle = (document.title || '').replace(/\s+/g, ' ').trim();
  const pageUrl = location.href || '';
  const safeMaxChars = typeof maxChars === 'number' && maxChars > 0 ? maxChars : 24000;

  try {
    const rawSelection = (window.getSelection?.()?.toString() ?? '').trim();
    if (mode === 'selection' || (mode === 'auto' && rawSelection.length >= 10)) {
      const { text, truncated } = truncateLocal(rawSelection, safeMaxChars);
      return {
        mode: 'selection',
        title: pageTitle,
        url: pageUrl,
        content: text,
        fullContent: rawSelection,
        selectionText: rawSelection,
        contentHash: fnv1aHashLocal(rawSelection),
        charCount: rawSelection.length,
        truncated,
      };
    }

    const isVisible = (el: Element): boolean => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.hidden || el.getAttribute('aria-hidden') === 'true') return false;
      const st = window.getComputedStyle(htmlEl);
      return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
    };

    if (mode === 'interactive' || mode === 'aom') {
      const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"]';
      const nodes: string[] = [];
      let id = 1;
      for (const el of Array.from(document.querySelectorAll(selector))) {
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || (tag === 'a' ? 'link' : tag);
        const inp = el as HTMLInputElement;
        const name = (
          el.getAttribute('aria-label') ||
          (el as HTMLElement).innerText ||
          inp.placeholder ||
          inp.name ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80);
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);
        nodes.push(`[${id++} | ${role} | ${name || '-'} | - | (${cx},${cy})]`);
      }
      const raw = nodes.join('\n');
      const { text, truncated } = truncateLocal(raw, safeMaxChars);
      return {
        mode: mode === 'aom' ? 'aom' : 'interactive',
        title: pageTitle,
        url: pageUrl,
        content: text,
        fullContent: raw,
        contentHash: fnv1aHashLocal(raw),
        charCount: raw.length,
        truncated,
      };
    }

    const root = document.querySelector('article, main, [role="main"]') ?? document.body ?? document.documentElement;
    const blocks: string[] = [];
    if (root) {
      for (const el of Array.from(root.querySelectorAll('h1, h2, h3, p, li, blockquote, pre'))) {
        if (!isVisible(el) || el.closest('nav, footer, aside, script, style')) continue;
        const txt = ((el as HTMLElement).innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (txt) blocks.push(txt);
      }
    }

    if (includeLinks) {
      const linkLines: string[] = [];
      for (const a of Array.from(document.querySelectorAll('a[href]')).slice(0, 30)) {
        if (!isVisible(a)) continue;
        const href = a.getAttribute('href') || '';
        const lbl = ((a as HTMLElement).innerText || a.textContent || '').replace(/\s+/g, ' ').trim();
        if (lbl && href && !href.startsWith('javascript:')) {
          linkLines.push(`- [${lbl}](${href})`);
        }
      }
      if (linkLines.length > 0) {
        blocks.push(`## Links\n${linkLines.join('\n')}`);
      }
    }

    const full = blocks.join('\n\n').trim();
    const { text, truncated } = truncateLocal(full, safeMaxChars);
    return {
      mode: 'article',
      title: pageTitle,
      url: pageUrl,
      content: text,
      fullContent: full,
      contentHash: fnv1aHashLocal(full),
      charCount: full.length,
      truncated,
    };
  } catch (err: unknown) {
    return {
      mode: 'article',
      title: pageTitle,
      url: pageUrl,
      content: '',
      contentHash: '00000000',
      charCount: 0,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
