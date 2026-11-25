const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'by', 'for', 'from',
  'has', 'have', 'in', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
  'this', 'to', 'was', 'were', 'will', 'with',
]);

function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9]+/g);
  if (!raw) return [];
  return raw.filter((tok) => tok.length > 1 && !STOPWORDS.has(tok));
}

function splitMarkdownIntoChunks(markdown: string): string[] {
  const normalized = markdown.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];

  const rawBlocks = normalized
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const mergedBlocks: string[] = [];
  for (let i = 0; i < rawBlocks.length; i++) {
    const block = rawBlocks[i];
    if (/^#{1,6}\s/.test(block) && i + 1 < rawBlocks.length && block.length + rawBlocks[i + 1].length + 2 <= 900) {
      mergedBlocks.push(`${block}\n\n${rawBlocks[i + 1]}`);
      i++;
    } else {
      mergedBlocks.push(block);
    }
  }

  const chunks: string[] = [];
  let buffer = '';
  const flushBuffer = () => {
    if (buffer.trim()) {
      chunks.push(buffer.trim());
      buffer = '';
    }
  };

  for (const block of mergedBlocks) {
    if (block.length > 900) {
      flushBuffer();
      const parts = block.split(/(?<=[.!?])\s+|\n+/);
      let sub = '';
      for (const part of parts) {
        if (!part) continue;
        if (sub.length + part.length + 1 <= 850) {
          sub = sub ? `${sub} ${part}` : part;
        } else {
          if (sub) chunks.push(sub.trim());
          if (part.length > 900) {
            for (let start = 0; start < part.length; start += 800) {
              chunks.push(part.slice(start, start + 800).trim());
            }
            sub = '';
          } else {
            sub = part;
          }
        }
      }
      if (sub.trim()) chunks.push(sub.trim());
      continue;
    }

    if (!buffer) {
      buffer = block;
    } else if (!/^#{1,6}\s/.test(block) && buffer.length < 300 && buffer.length + block.length + 2 <= 900) {
      buffer = `${buffer}\n\n${block}`;
    } else {
      flushBuffer();
      buffer = block;
    }
  }
  flushBuffer();
  return chunks;
}

/**
 * Ranks markdown chunks against a query using BM25 and reassembles top passages in original reading order.
 */
export function rankPassagesBm25(
  markdown: string,
  query: string,
  maxChars = 4800,
): { excerpt: string; selectedChunks: number; totalChunks: number; topScore: number } {
  const chunks = splitMarkdownIntoChunks(markdown);
  const totalChunks = chunks.length;
  if (totalChunks === 0 || maxChars <= 0) {
    return { excerpt: '', selectedChunks: 0, totalChunks: 0, topScore: 0 };
  }

  const queryTokens = Array.from(new Set(tokenize(query)));
  if (queryTokens.length === 0) {
    const selected: number[] = [];
    let used = 0;
    for (let i = 0; i < chunks.length; i++) {
      const sep = selected.length > 0 ? 2 : 0;
      if (used + sep + chunks[i].length <= maxChars || selected.length === 0) {
        selected.push(i);
        used += sep + chunks[i].length;
      } else break;
    }
    const rawExcerpt = selected.map((i) => chunks[i]).join('\n\n');
    const excerpt = rawExcerpt.length > maxChars ? rawExcerpt.slice(0, maxChars) : rawExcerpt;
    return { excerpt, selectedChunks: selected.length, totalChunks, topScore: 0 };
  }

  const k1 = 1.2;
  const b = 0.75;
  const docTokens = chunks.map((chunk) => tokenize(chunk));
  const docLengths = docTokens.map((t) => t.length);
  const avgDocLen = docLengths.reduce((sum, len) => sum + len, 0) / totalChunks || 1;

  const df = new Map<string, number>();
  const tfMaps = docTokens.map((tokens) => {
    const tf = new Map<string, number>();
    for (const tok of tokens) tf.set(tok, (tf.get(tok) ?? 0) + 1);
    for (const term of tf.keys()) df.set(term, (df.get(term) ?? 0) + 1);
    return tf;
  });

  const scores = chunks.map((_chunk, idx) => {
    const tf = tfMaps[idx];
    const dl = docLengths[idx];
    let score = 0;
    for (const term of queryTokens) {
      const freq = tf.get(term) ?? 0;
      if (freq === 0) continue;
      const docFreq = df.get(term) ?? 0;
      const idf = Math.log((totalChunks - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const tfNorm = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (dl / avgDocLen)));
      score += idf * tfNorm;
    }
    return score;
  });

  const topScore = scores.reduce((max, s) => (s > max ? s : max), 0);
  const rankedIndices = chunks
    .map((_, idx) => idx)
    .sort((a, bIdx) => (scores[bIdx] !== scores[a] ? scores[bIdx] - scores[a] : a - bIdx));

  const selectedSet = new Set<number>();
  let usedChars = 0;
  if (chunks[0].length <= maxChars) {
    selectedSet.add(0);
    usedChars = chunks[0].length;
  }

  for (const idx of rankedIndices) {
    if (selectedSet.has(idx)) continue;
    const sep = selectedSet.size > 0 ? 2 : 0;
    if (usedChars + sep + chunks[idx].length <= maxChars) {
      selectedSet.add(idx);
      usedChars += sep + chunks[idx].length;
    }
  }

  if (selectedSet.size === 0) {
    const bestIdx = rankedIndices[0];
    return { excerpt: chunks[bestIdx].slice(0, maxChars), selectedChunks: 1, totalChunks, topScore };
  }

  const orderedIndices = Array.from(selectedSet).sort((a, bIdx) => a - bIdx);
  return {
    excerpt: orderedIndices.map((idx) => chunks[idx]).join('\n\n'),
    selectedChunks: orderedIndices.length,
    totalChunks,
    topScore,
  };
}
