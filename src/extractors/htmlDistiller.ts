const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·',
  laquo: '«',
  raquo: '»',
  times: '×',
  divide: '÷',
  plusmn: '±',
  deg: '°',
};

export function decodeHtmlEntities(input: string): string {
  if (!input.includes('&')) {
    return input;
  }
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]+);/g, (full, entity: string) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const codePoint = Number.parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return full;
        }
      }
      return full;
    }
    const lower = entity.toLowerCase();
    return NAMED_ENTITIES[lower] ?? NAMED_ENTITIES[entity] ?? full;
  });
}

function stripTagsQuick(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function findMatchingCloseTag(html: string, tagName: string, openEndIdx: number): number {
  const lower = html.toLowerCase();
  const openToken = `<${tagName}`;
  const closeToken = `</${tagName}`;
  let depth = 1;
  let pos = openEndIdx;

  while (pos < lower.length && depth > 0) {
    const nextOpen = lower.indexOf(openToken, pos);
    const nextClose = lower.indexOf(closeToken, pos);

    if (nextClose === -1) {
      return -1;
    }

    if (nextOpen !== -1 && nextOpen < nextClose) {
      const charAfter = lower[nextOpen + openToken.length];
      if (
        charAfter === '>' ||
        charAfter === ' ' ||
        charAfter === '\t' ||
        charAfter === '\n' ||
        charAfter === '\r' ||
        charAfter === '/'
      ) {
        const tagEnd = lower.indexOf('>', nextOpen);
        if (tagEnd === -1) {
          return -1;
        }
        if (lower[tagEnd - 1] !== '/') {
          depth++;
        }
        pos = tagEnd + 1;
        continue;
      }
      pos = nextOpen + openToken.length;
      continue;
    }

    const closeEnd = lower.indexOf('>', nextClose);
    if (closeEnd === -1) {
      return -1;
    }
    const charAfterClose = lower[nextClose + closeToken.length];
    if (
      charAfterClose === '>' ||
      charAfterClose === ' ' ||
      charAfterClose === '\t' ||
      charAfterClose === '\n' ||
      charAfterClose === '\r'
    ) {
      depth--;
      if (depth === 0) {
        return closeEnd + 1;
      }
    }
    pos = closeEnd + 1;
  }

  return -1;
}

function removeTagBlocks(html: string, tagNames: string[]): string {
  let out = html;
  for (const tag of tagNames) {
    const openRegex = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi');
    let result = '';
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    openRegex.lastIndex = 0;
    while ((match = openRegex.exec(out)) !== null) {
      if (match.index < lastIndex) {
        continue;
      }
      result += out.slice(lastIndex, match.index);
      const openEnd = match.index + match[0].length;
      if (match[0].endsWith('/>')) {
        lastIndex = openEnd;
        continue;
      }
      const closeEnd = findMatchingCloseTag(out, tag, openEnd);
      if (closeEnd === -1) {
        const fallbackClose = out.toLowerCase().indexOf(`</${tag}>`, openEnd);
        lastIndex = fallbackClose !== -1 ? fallbackClose + tag.length + 3 : openEnd;
      } else {
        lastIndex = closeEnd;
      }
      openRegex.lastIndex = lastIndex;
    }
    result += out.slice(lastIndex);
    out = result;
  }
  return out;
}

const NOISE_ATTR_RE =
  /\b(?:cookie[-_]?(?:banner|consent|notice|bar|popup|modal|wall)|gdpr[-_]?(?:banner|consent|modal)|onetrust|cookiebot|ad[-_]?(?:slot|banner|container|wrapper|unit|box)|adsbygoogle|advertisement|sponsored[-_]?content|newsletter[-_]?(?:popup|banner|modal))\b/i;

function removeNoiseAttributeBlocks(html: string): string {
  const blockTagRegex = /<(div|section|aside|dialog|p)\b([^>]*)>/gi;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockTagRegex.exec(html)) !== null) {
    if (match.index < lastIndex) {
      continue;
    }
    const attrs = match[2] ?? '';
    const idOrClassMatch = /(?:id|class)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let isNoise = false;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = idOrClassMatch.exec(attrs)) !== null) {
      const val = attrMatch[1] ?? attrMatch[2] ?? '';
      if (NOISE_ATTR_RE.test(val)) {
        isNoise = true;
        break;
      }
    }

    if (!isNoise) {
      continue;
    }

    const tagName = match[1].toLowerCase();
    const openEnd = match.index + match[0].length;
    if (match[0].endsWith('/>')) {
      result += html.slice(lastIndex, match.index);
      lastIndex = openEnd;
      blockTagRegex.lastIndex = lastIndex;
      continue;
    }

    const closeEnd = findMatchingCloseTag(html, tagName, openEnd);
    if (closeEnd !== -1 && closeEnd - match.index < html.length * 0.6) {
      result += html.slice(lastIndex, match.index);
      lastIndex = closeEnd;
      blockTagRegex.lastIndex = lastIndex;
    }
  }

  result += html.slice(lastIndex);
  return result;
}

function extractTagInner(html: string, tagName: string): string[] {
  const results: string[] = [];
  const openRegex = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'gi');
  let match: RegExpExecArray | null;

  while ((match = openRegex.exec(html)) !== null) {
    const openEnd = match.index + match[0].length;
    if (match[0].endsWith('/>')) {
      continue;
    }
    const closeEnd = findMatchingCloseTag(html, tagName, openEnd);
    if (closeEnd !== -1) {
      const closeStart = html.toLowerCase().lastIndexOf(`</${tagName}`, closeEnd);
      if (closeStart >= openEnd) {
        results.push(html.slice(openEnd, closeStart));
      }
      openRegex.lastIndex = closeEnd;
    }
  }

  return results;
}

function resolveHref(rawHref: string, baseUrl?: string): string | null {
  const trimmed = decodeHtmlEntities(rawHref).trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('vbscript:') || lower.startsWith('data:')) {
    return null;
  }
  if (baseUrl) {
    try {
      const resolved = new URL(trimmed, baseUrl);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') {
        return resolved.toString();
      }
      return null;
    } catch {
      return null;
    }
  }
  if (lower.startsWith('http://') || lower.startsWith('https://') || trimmed.startsWith('/')) {
    return trimmed;
  }
  return null;
}

function convertTableToMarkdown(
  tableHtml: string,
  baseUrl: string | undefined,
  includeLinks: boolean,
  linksOut?: Array<{ text: string; url: string }>,
): string {
  const rows: string[][] = [];
  const rowMatches = tableHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? [];

  for (const rowHtml of rowMatches) {
    const cells: string[] = [];
    const cellRegex = /<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      const cellInline = convertInlineHtml(cellMatch[2], baseUrl, includeLinks, linksOut)
        .replace(/\|/g, '\\|')
        .replace(/\s+/g, ' ')
        .trim();
      cells.push(cellInline);
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) {
    return '';
  }

  const colCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
  if (colCount === 0) {
    return '';
  }

  const normalizeRow = (r: string[]) => {
    const padded = [...r];
    while (padded.length < colCount) {
      padded.push('');
    }
    return `| ${padded.join(' | ')} |`;
  };

  const lines: string[] = [normalizeRow(rows[0])];
  lines.push(`| ${Array(colCount).fill('---').join(' | ')} |`);
  for (let i = 1; i < rows.length; i++) {
    lines.push(normalizeRow(rows[i]));
  }
  return `\n\n${lines.join('\n')}\n\n`;
}

function convertInlineHtml(
  fragment: string,
  baseUrl: string | undefined,
  includeLinks: boolean,
  linksOut?: Array<{ text: string; url: string }>,
): string {
  let out = fragment;

  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, inner: string) => {
    const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).trim();
    return text ? `\`${text.replace(/`/g, "'")}\`` : '';
  });

  out = out.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const linkText = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    if (!linkText) {
      return '';
    }
    const hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const rawHref = hrefMatch ? hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? '' : '';
    const resolved = resolveHref(rawHref, baseUrl);
    if (!resolved) {
      return linkText;
    }
    if (linksOut) {
      linksOut.push({ text: linkText, url: resolved });
    }
    return includeLinks ? `[${linkText}](${resolved})` : linkText;
  });

  out = out.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return text ? `**${text}**` : '';
  });
  out = out.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, inner: string) => {
    const text = decodeHtmlEntities(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    return text ? `*${text}*` : '';
  });

  return out;
}

function htmlFragmentToMarkdown(
  fragment: string,
  baseUrl: string | undefined,
  includeLinks: boolean,
  linksOut?: Array<{ text: string; url: string }>,
): string {
  let work = fragment;

  const preBlocks: string[] = [];
  work = work.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, inner: string) => {
    const langMatch = /class\s*=\s*["'][^"']*language-([a-zA-Z0-9_-]+)/i.exec(inner);
    const lang = langMatch ? langMatch[1] : '';
    const codeText = decodeHtmlEntities(inner.replace(/<[^>]+>/g, '')).replace(/\r\n/g, '\n').trim();
    const token = `\n\n__YOURS_PRE_${preBlocks.length}__\n\n`;
    preBlocks.push(`\`\`\`${lang}\n${codeText}\n\`\`\``);
    return token;
  });

  work = work.replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (tableHtml) =>
    convertTableToMarkdown(tableHtml, baseUrl, includeLinks, linksOut),
  );

  work = work.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, levelStr: string, inner: string) => {
    const level = Number.parseInt(levelStr, 10);
    const headingText = convertInlineHtml(inner, baseUrl, includeLinks, linksOut)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!headingText) {
      return '';
    }
    return `\n\n${'#'.repeat(level)} ${headingText}\n\n`;
  });

  work = work.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, inner: string) => {
    const quoteText = convertInlineHtml(inner, baseUrl, includeLinks, linksOut)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return quoteText ? `\n\n> ${quoteText}\n\n` : '';
  });

  work = work.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_m, inner: string) => {
    const itemText = convertInlineHtml(inner, baseUrl, includeLinks, linksOut)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return itemText ? `\n- ${itemText}` : '';
  });

  work = convertInlineHtml(work, baseUrl, includeLinks, linksOut);

  work = work.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');
  work = work.replace(/<br\b[^>]*\/?>/gi, '\n');
  work = work.replace(/<\/(p|div|section|article|main|ul|ol|dl|dt|dd|figcaption|figure)>/gi, '\n\n');
  work = work.replace(/<(p|div|section|article|main|ul|ol|dl|dt|dd|figcaption|figure)\b[^>]*>/gi, '\n');

  work = work.replace(/<[^>]+>/g, ' ');
  work = decodeHtmlEntities(work);

  const lines = work
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim());

  let normalized = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  for (let i = 0; i < preBlocks.length; i++) {
    normalized = normalized.replace(`__YOURS_PRE_${i}__`, preBlocks[i]);
  }

  return normalized.replace(/\n{3,}/g, '\n\n').trim();
}

function truncateCleanly(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  if (maxChars <= 0) {
    return '';
  }
  const slice = text.slice(0, maxChars);
  const lastBreak = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
  const cutoff = lastBreak > maxChars * 0.65 ? lastBreak : maxChars;
  return `${slice.slice(0, cutoff).trimEnd()}\n… [truncated]`;
}

/**
 * Distills raw HTML into clean Markdown, stripping scripts, styles, navigation, and cookie/ad noise.
 */
export function distillHtmlToMarkdown(
  html: string,
  options?: { maxChars?: number; baseUrl?: string; includeLinks?: boolean },
): {
  title: string;
  markdown: string;
  textLength: number;
  links: Array<{ text: string; url: string }>;
} {
  const maxChars = options?.maxChars ?? 8000;
  const baseUrl = options?.baseUrl;
  const includeLinks = options?.includeLinks ?? true;
  const links: Array<{ text: string; url: string }> = [];

  if (!html || typeof html !== 'string') {
    return { title: '', markdown: '', textLength: 0, links };
  }

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? stripTagsQuick(titleMatch[1]) : '';

  let cleaned = html.replace(/<!--[\s\S]*?-->/g, '');
  cleaned = removeTagBlocks(cleaned, [
    'script',
    'style',
    'noscript',
    'svg',
    'iframe',
    'nav',
    'footer',
    'header',
    'aside',
    'template',
  ]);
  cleaned = removeNoiseAttributeBlocks(cleaned);

  const articles = extractTagInner(cleaned, 'article');
  const mains = extractTagInner(cleaned, 'main');
  const bodies = extractTagInner(cleaned, 'body');

  const bodyFragment = bodies.length > 0 ? bodies.join('\n') : cleaned;
  const bodyMd = htmlFragmentToMarkdown(bodyFragment, baseUrl, includeLinks, links);

  let chosenMd = bodyMd;
  if (articles.length > 0 || mains.length > 0) {
    const candidateLinks: Array<{ text: string; url: string }> = [];
    const articleMd =
      articles.length > 0
        ? htmlFragmentToMarkdown(articles.join('\n\n'), baseUrl, includeLinks, candidateLinks)
        : '';
    const mainMd =
      mains.length > 0
        ? htmlFragmentToMarkdown(mains.join('\n\n'), baseUrl, includeLinks, candidateLinks)
        : '';
    const bestCandidate = articleMd.length >= 120 ? articleMd : mainMd;
    if (
      bestCandidate.length >= 120 &&
      (bodyMd.length === 0 || bestCandidate.length >= bodyMd.length * 0.15)
    ) {
      chosenMd = bestCandidate;
    }
  }

  const fullTextLength = chosenMd.length;
  const truncated = truncateCleanly(chosenMd, maxChars);

  const dedupedLinks: Array<{ text: string; url: string }> = [];
  const seenLinkUrls = new Set<string>();
  for (const link of links) {
    if (!seenLinkUrls.has(link.url)) {
      seenLinkUrls.add(link.url);
      dedupedLinks.push(link);
    }
  }

  return {
    title,
    markdown: truncated,
    textLength: fullTextLength,
    links: dedupedLinks,
  };
}

function extractBalancedJsonObject(source: string, startBraceIdx: number): string | null {
  if (source[startBraceIdx] !== '{') {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startBraceIdx; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(startBraceIdx, i + 1);
      }
    }
  }
  return null;
}

interface CaptionTrackRaw {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
}

export function extractYouTubeCaptionTrack(
  html: string,
): { title: string; captionBaseUrl: string; languageCode: string } | null {
  if (!html) {
    return null;
  }

  let title = '';
  let captionTracks: CaptionTrackRaw[] = [];

  const markerRegex = /ytInitialPlayerResponse\s*=\s*\{/g;
  const markerMatch = markerRegex.exec(html);
  if (markerMatch) {
    const braceIdx = markerMatch.index + markerMatch[0].length - 1;
    const jsonStr = extractBalancedJsonObject(html, braceIdx);
    if (jsonStr) {
      try {
        const parsed = JSON.parse(jsonStr) as {
          videoDetails?: { title?: string };
          captions?: {
            playerCaptionsTracklistRenderer?: {
              captionTracks?: CaptionTrackRaw[];
            };
          };
        };
        title = parsed.videoDetails?.title ?? '';
        captionTracks = parsed.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      } catch {
        // Fallback to regex scan
      }
    }
  }

  if (captionTracks.length === 0) {
    const tracksMatch = /"captionTracks"\s*:\s*(\[[\s\S]*?\])/.exec(html);
    if (tracksMatch) {
      try {
        captionTracks = JSON.parse(tracksMatch[1]) as CaptionTrackRaw[];
      } catch {
        captionTracks = [];
      }
    }
  }

  if (!title) {
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    title = titleMatch ? stripTagsQuick(titleMatch[1]).replace(/\s*-\s*YouTube$/i, '').trim() : '';
  }

  const validTracks = captionTracks.filter(
    (t): t is Required<Pick<CaptionTrackRaw, 'baseUrl' | 'languageCode'>> & CaptionTrackRaw =>
      typeof t.baseUrl === 'string' && t.baseUrl.length > 0 && typeof t.languageCode === 'string',
  );

  if (validTracks.length === 0) {
    return null;
  }

  const isEnglish = (code: string) => /^en(?:[-_]|$)/i.test(code);
  const chosen =
    validTracks.find((t) => isEnglish(t.languageCode) && t.kind !== 'asr') ??
    validTracks.find((t) => isEnglish(t.languageCode)) ??
    validTracks.find((t) => t.kind !== 'asr') ??
    validTracks[0];

  const captionBaseUrl = chosen.baseUrl.replace(/\\u0026/g, '&');

  return {
    title,
    captionBaseUrl,
    languageCode: chosen.languageCode,
  };
}

function formatTimestampMmSs(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function parseYouTubeTranscriptXml(xml: string, maxChars = 12000): string {
  if (!xml) {
    return '';
  }

  const lines: string[] = [];
  const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match: RegExpExecArray | null;

  while ((match = textRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const rawBody = match[2];
    const startMatch = /\bstart\s*=\s*["']([0-9.]+)["']/i.exec(attrs);
    const startSec = startMatch ? Number.parseFloat(startMatch[1]) : 0;

    const decodedOnce = decodeHtmlEntities(rawBody.replace(/<[^>]+>/g, ' '));
    const decodedTwice = decodeHtmlEntities(decodedOnce).replace(/\s+/g, ' ').trim();
    if (!decodedTwice) {
      continue;
    }

    lines.push(`[${formatTimestampMmSs(startSec)}] ${decodedTwice}`);
  }

  if (lines.length === 0) {
    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((match = pRegex.exec(xml)) !== null) {
      const attrs = match[1];
      const tMatch = /\bt\s*=\s*["']([0-9]+)["']/i.exec(attrs);
      const startSec = tMatch ? Number.parseInt(tMatch[1], 10) / 1000 : 0;
      const text = decodeHtmlEntities(decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' ')))
        .replace(/\s+/g, ' ')
        .trim();
      if (text) {
        lines.push(`[${formatTimestampMmSs(startSec)}] ${text}`);
      }
    }
  }

  return truncateCleanly(lines.join('\n'), maxChars);
}

export function formatInteractiveElements(
  elements: Array<{ id: number; role: string; name: string; state?: string; cx: number; cy: number }>,
  maxItems = 120,
): string {
  if (!elements || elements.length === 0) {
    return '';
  }
  const limit = Math.max(1, maxItems);
  const sliced = elements.slice(0, limit);
  const lines = sliced.map((el) => {
    const role = (el.role || 'element').replace(/\|/g, '/').trim();
    const name = (el.name || '').replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || '-';
    const state = (el.state || '-').replace(/[\r\n|]+/g, ' ').trim() || '-';
    const cx = Math.round(el.cx);
    const cy = Math.round(el.cy);
    return `[${el.id} | ${role} | ${name} | ${state} | (${cx},${cy})]`;
  });

  if (elements.length > sliced.length) {
    lines.push(`... (+${elements.length - sliced.length} more elements)`);
  }

  return lines.join('\n');
}
