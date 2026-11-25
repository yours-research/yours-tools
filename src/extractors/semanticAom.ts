import type {
  SemanticFormSummary,
  SemanticLandmark,
  SemanticNode,
  SemanticSnapshot,
  SemanticTableSummary,
} from '../types.js';

export interface SemanticExtractOptions {
  maxInteractiveNodes?: number;
  maxChars?: number;
  includeLinks?: boolean;
}

export interface SemanticExtractionOutput {
  snapshot: SemanticSnapshot;
  elementMap: Map<number, Element>;
}

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[contenteditable="true"]',
].join(', ');

const LANDMARK_SELECTOR = [
  'header',
  'nav',
  'main',
  'aside',
  'footer',
  'form',
  '[role="banner"]',
  '[role="navigation"]',
  '[role="main"]',
  '[role="complementary"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[role="region"]',
].join(', ');

function detectLayoutEngine(doc: Document): boolean {
  const root = doc.body ?? doc.documentElement;
  if (!root || typeof root.getBoundingClientRect !== 'function') {
    return false;
  }
  const rect = root.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0;
}

function isElementVisible(doc: Document, el: Element, hasLayout: boolean): boolean {
  const win = doc.defaultView;
  let cur: Element | null = el;
  while (cur) {
    const htmlEl = cur as HTMLElement;
    if (htmlEl.hidden || cur.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    if (win && typeof win.getComputedStyle === 'function') {
      const style = win.getComputedStyle(htmlEl);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
    } else {
      const inlineStyle = (cur.getAttribute('style') ?? '').toLowerCase();
      if (/display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0\b/.test(inlineStyle)) {
        return false;
      }
    }
    cur = cur.parentElement;
  }
  if (hasLayout && typeof (el as HTMLElement).getBoundingClientRect === 'function') {
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }
  }
  return true;
}

function resolveAccessibleName(doc: Document, el: Element): string {
  const htmlEl = el as HTMLElement;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel && ariaLabel.trim()) {
    return ariaLabel.trim();
  }

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map((id) => doc.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean);
    if (parts.length > 0) {
      return parts.join(' ');
    }
  }

  const id = el.getAttribute('id');
  if (id) {
    try {
      const escapedId = id.replace(/"/g, '\\"');
      const labelEl = doc.querySelector(`label[for="${escapedId}"]`);
      if (labelEl?.textContent?.trim()) {
        return labelEl.textContent.trim();
      }
    } catch {
      // Ignore invalid selector
    }
  }

  const enclosingLabel = el.closest?.('label');
  if (enclosingLabel?.textContent?.trim()) {
    return enclosingLabel.textContent.trim();
  }

  const inputEl = el as HTMLInputElement;
  const text =
    htmlEl.innerText ||
    el.textContent ||
    inputEl.placeholder ||
    el.getAttribute('title') ||
    inputEl.name ||
    el.getAttribute('alt') ||
    '';

  return text.replace(/[\r\n|]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveSemanticRole(el: Element): string {
  const explicit = el.getAttribute('role');
  if (explicit && explicit.trim()) {
    return explicit.trim().toLowerCase();
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'range') return 'slider';
    return `textbox:${type}`;
  }
  if (el.getAttribute('contenteditable') === 'true') {
    return 'textbox';
  }
  return tag;
}

function buildLocator(el: Element): string {
  const id = el.getAttribute('id');
  if (id) {
    return `#${id}`;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && cur.nodeType === 1 && depth < 5) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') {
      parts.unshift(tag);
      break;
    }
    const parent: Element | null = cur.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter((c) => c.tagName === cur!.tagName);
    if (siblings.length > 1) {
      const index = siblings.indexOf(cur) + 1;
      parts.unshift(`${tag}:nth-of-type(${index})`);
    } else {
      parts.unshift(tag);
    }
    cur = parent;
    depth++;
  }
  return parts.join(' > ');
}

function collectAcrossShadowRoots(root: ParentNode, selector: string, out: Element[]): void {
  for (const el of Array.from(root.querySelectorAll(selector))) {
    out.push(el);
  }
  for (const host of Array.from(root.querySelectorAll('*'))) {
    const sr = (host as HTMLElement).shadowRoot;
    if (sr) {
      collectAcrossShadowRoots(sr, selector, out);
    }
  }
}

/**
 * Formats a SemanticSnapshot into a compact, token-efficient text representation
 * suitable for local 2B-9B browser agents.
 */
export function formatSemanticSnapshot(snapshot: SemanticSnapshot): string {
  const sections: string[] = [];
  sections.push(`# ${snapshot.title || '(untitled)'}\nURL: ${snapshot.url || 'about:blank'}`);

  if (snapshot.landmarks.length > 0) {
    const lmLine = snapshot.landmarks
      .map((l) => (l.label ? `${l.role}("${l.label}")` : l.role))
      .join(', ');
    sections.push(`## Landmarks\n${lmLine}`);
  }

  if (snapshot.outline.length > 0) {
    sections.push(`## Outline\n${snapshot.outline.slice(0, 15).map((h) => `- ${h}`).join('\n')}`);
  }

  if (snapshot.interactiveNodes.length > 0) {
    const nodeLines = snapshot.interactiveNodes.map((n) => {
      const stateStr = n.state.length > 0 ? n.state.join(',') : '-';
      const hrefStr = n.href ? ` -> ${n.href}` : '';
      return `[${n.nodeId}] ${n.role} "${n.name || '-'}" (${stateStr})${hrefStr}`;
    });
    sections.push(`## Interactive Elements\n${nodeLines.join('\n')}`);
  }

  if (snapshot.forms.length > 0) {
    const formLines = snapshot.forms.map(
      (f, idx) =>
        `- Form ${idx + 1}${f.name || f.id ? ` (${f.name || f.id})` : ''}: fields=[${f.fieldNodeIds.join(', ')}]`,
    );
    sections.push(`## Forms\n${formLines.join('\n')}`);
  }

  if (snapshot.tables.length > 0) {
    const tableBlocks = snapshot.tables.map((t, idx) => {
      const headerLine = t.headers.length > 0 ? `| ${t.headers.join(' | ')} |` : '';
      const previewRows = t.rows.slice(0, 5).map((r) => `| ${r.join(' | ')} |`);
      return [`Table ${idx + 1}${t.caption ? `: ${t.caption}` : ''} (${t.rowCount} rows)`, headerLine, ...previewRows]
        .filter(Boolean)
        .join('\n');
    });
    sections.push(`## Tables\n${tableBlocks.join('\n\n')}`);
  }

  if (snapshot.viewportExcerpt) {
    sections.push(`## Visible Excerpt\n${snapshot.viewportExcerpt}`);
  } else if (snapshot.mainText) {
    sections.push(`## Content\n${snapshot.mainText}`);
  }

  return sections.join('\n\n').trim();
}

/**
 * Extracts a compact Semantic Accessibility Tree (AOM) snapshot from any DOM `Document`
 * (browser live DOM, iframe contentDocument, or JSDOM).
 */
export function extractSemanticSnapshot(
  doc: Document,
  options?: SemanticExtractOptions,
): SemanticExtractionOutput {
  const maxInteractive = Math.max(1, options?.maxInteractiveNodes ?? 120);
  const maxChars = Math.max(500, options?.maxChars ?? 16000);
  const includeLinks = options?.includeLinks ?? false;
  const hasLayout = detectLayoutEngine(doc);

  const title = (doc.title || '').replace(/\s+/g, ' ').trim();
  const url = doc.location?.href || doc.URL || '';
  const rawHtmlLength = (doc.documentElement?.outerHTML ?? '').length;

  // 1. Landmarks
  const landmarks: SemanticLandmark[] = [];
  const seenLandmarks = new Set<string>();
  for (const el of Array.from(doc.querySelectorAll(LANDMARK_SELECTOR))) {
    if (!isElementVisible(doc, el, hasLayout)) continue;
    const tag = el.tagName.toLowerCase();
    const role =
      el.getAttribute('role')?.toLowerCase() ??
      (tag === 'header'
        ? 'banner'
        : tag === 'nav'
          ? 'navigation'
          : tag === 'aside'
            ? 'complementary'
            : tag === 'footer'
              ? 'contentinfo'
              : tag);
    const label = el.getAttribute('aria-label')?.trim() || undefined;
    const key = `${role}:${label ?? ''}`;
    if (!seenLandmarks.has(key)) {
      seenLandmarks.add(key);
      landmarks.push({ role, ...(label ? { label } : {}) });
    }
  }

  // 2. Outline (h1-h3)
  const outline: string[] = [];
  for (const h of Array.from(doc.querySelectorAll('h1, h2, h3'))) {
    if (!isElementVisible(doc, h, hasLayout)) continue;
    const txt = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (txt && outline.length < 25) {
      outline.push(`${h.tagName.toLowerCase()}: ${txt.slice(0, 120)}`);
    }
  }

  // 3. Interactive nodes (piercing Shadow DOM)
  const rawInteractive: Element[] = [];
  collectAcrossShadowRoots(doc, INTERACTIVE_SELECTOR, rawInteractive);
  const seenEls = new Set<Element>();
  const interactiveNodes: SemanticNode[] = [];
  const elementMap = new Map<number, Element>();
  const elementToNodeId = new Map<Element, number>();

  let nextId = 1;
  for (const el of rawInteractive) {
    if (seenEls.has(el)) continue;
    seenEls.add(el);
    if (!isElementVisible(doc, el, hasLayout)) continue;
    if (interactiveNodes.length >= maxInteractive) break;

    const role = resolveSemanticRole(el);
    const name = resolveAccessibleName(doc, el).slice(0, 80);
    const tag = el.tagName.toLowerCase();
    const inputEl = el as HTMLInputElement;

    const states: string[] = [];
    if ('disabled' in inputEl && inputEl.disabled) states.push('disabled');
    if (el.getAttribute('aria-disabled') === 'true') states.push('disabled');
    if (el.getAttribute('required') !== null || inputEl.required) states.push('required');
    if (el.getAttribute('readonly') !== null || inputEl.readOnly) states.push('readonly');
    if (el.getAttribute('aria-expanded')) states.push(`expanded=${el.getAttribute('aria-expanded')}`);
    if (el.getAttribute('aria-selected') === 'true') states.push('selected');
    if ('checked' in inputEl && (inputEl.type === 'checkbox' || inputEl.type === 'radio')) {
      states.push(inputEl.checked ? 'checked' : 'unchecked');
    }

    let value: string | undefined;
    if (tag === 'input' && inputEl.type !== 'password' && inputEl.type !== 'checkbox' && inputEl.type !== 'radio') {
      if (inputEl.value) {
        value = inputEl.value.slice(0, 40);
        states.push(`val=${value}`);
      }
    } else if (tag === 'textarea') {
      const ta = el as HTMLTextAreaElement;
      if (ta.value) {
        value = ta.value.slice(0, 40);
        states.push(`val=${value}`);
      }
    } else if (tag === 'select') {
      const sel = el as HTMLSelectElement;
      const opt = sel.options?.[sel.selectedIndex];
      if (opt) {
        value = (opt.text || opt.value).slice(0, 40);
        states.push(`val=${value}`);
      }
    }

    const rect = typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);

    const rawHref = tag === 'a' ? el.getAttribute('href') || '' : '';
    const href = includeLinks && rawHref && !rawHref.startsWith('javascript:') ? rawHref : undefined;

    const nodeId = nextId++;
    elementMap.set(nodeId, el);
    elementToNodeId.set(el, nodeId);

    interactiveNodes.push({
      nodeId,
      role,
      name,
      tag,
      state: states,
      ...(value !== undefined ? { value } : {}),
      ...(href ? { href } : {}),
      cx,
      cy,
      locator: buildLocator(el),
    });
  }

  // 4. Forms summary
  const forms: SemanticFormSummary[] = [];
  for (const form of Array.from(doc.querySelectorAll('form'))) {
    if (!isElementVisible(doc, form, hasLayout)) continue;
    const fieldNodeIds: number[] = [];
    for (const control of Array.from(form.querySelectorAll('input, select, textarea, button'))) {
      const nid = elementToNodeId.get(control);
      if (nid !== undefined) {
        fieldNodeIds.push(nid);
      }
    }
    forms.push({
      ...(form.id ? { id: form.id } : {}),
      ...(form.getAttribute('name') ? { name: form.getAttribute('name')! } : {}),
      ...(form.getAttribute('action') ? { action: form.getAttribute('action')! } : {}),
      ...(form.getAttribute('method') ? { method: form.getAttribute('method')!.toUpperCase() } : {}),
      fieldNodeIds,
    });
  }

  // 5. Tables summary
  const tables: SemanticTableSummary[] = [];
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    if (!isElementVisible(doc, table, hasLayout)) continue;
    const caption = table.querySelector('caption')?.textContent?.replace(/\s+/g, ' ').trim() || undefined;
    const headers: string[] = [];
    const dataRows: string[][] = [];
    const trs = Array.from(table.querySelectorAll('tr'));
    for (let rIdx = 0; rIdx < trs.length; rIdx++) {
      const tr = trs[rIdx];
      const ths = Array.from(tr.children).filter((c) => c.tagName.toLowerCase() === 'th');
      const tds = Array.from(tr.children).filter((c) => c.tagName.toLowerCase() === 'td');
      if (rIdx === 0 && ths.length > 0 && tds.length === 0) {
        for (const th of ths) {
          headers.push((th.textContent ?? '').replace(/\s+/g, ' ').trim());
        }
      } else {
        const rowCells = Array.from(tr.children)
          .filter((c) => c.tagName.toLowerCase() === 'th' || c.tagName.toLowerCase() === 'td')
          .map((c) => (c.textContent ?? '').replace(/\s+/g, ' ').trim());
        if (rowCells.some(Boolean)) {
          dataRows.push(rowCells);
        }
      }
    }
    if (headers.length > 0 || dataRows.length > 0) {
      tables.push({
        ...(caption ? { caption } : {}),
        headers,
        rowCount: dataRows.length,
        rows: dataRows.slice(0, 10),
      });
    }
  }

  // 6. Primary main text & viewport excerpt (excluding script/style/nav/aside/footer/hidden)
  const contentRoot =
    doc.querySelector('main, [role="main"], article') ?? doc.body ?? doc.documentElement;
  const textBlocks: string[] = [];
  if (contentRoot) {
    const candidates = Array.from(contentRoot.querySelectorAll('h1, h2, h3, p, li, blockquote, pre'));
    for (const node of candidates) {
      if (!isElementVisible(doc, node, hasLayout)) continue;
      if (node.closest('nav, footer, aside, script, style, noscript')) continue;
      const t = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.length >= 8 && !textBlocks.includes(t)) {
        textBlocks.push(t);
      }
    }
  }

  const mainText = textBlocks.join('\n').slice(0, Math.min(maxChars, 4000));
  const viewportExcerpt = textBlocks.slice(0, 8).join('\n').slice(0, 1400);

  const snapshot: SemanticSnapshot = {
    title,
    url,
    landmarks,
    outline,
    interactiveNodes,
    forms,
    tables,
    viewportExcerpt,
    mainText,
    rawHtmlLength,
    compactText: '',
    compactCharCount: 0,
    compressionRatio: 1,
  };

  let compactText = formatSemanticSnapshot(snapshot);
  if (compactText.length > maxChars) {
    compactText = `${compactText.slice(0, maxChars).trimEnd()}\n… [truncated]`;
  }
  snapshot.compactText = compactText;
  snapshot.compactCharCount = compactText.length;
  snapshot.compressionRatio =
    rawHtmlLength > 0 ? Number((compactText.length / rawHtmlLength).toFixed(4)) : 1;

  return { snapshot, elementMap };
}

/**
 * Self-contained semantic AOM extraction script for `chrome.scripting.executeScript`.
 * IMPORTANT: Never references outer-scope helpers or variables.
 */
export function inPageSemanticExtractScript(
  maxInteractiveNodes = 120,
  maxChars = 16000,
  includeLinks = false,
): SemanticSnapshot {
  const isVisible = (el: Element): boolean => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(htmlEl);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = htmlEl.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const getName = (el: Element): string => {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const id = el.getAttribute('id');
    if (id) {
      const lbl = document.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`);
      if (lbl?.textContent?.trim()) return lbl.textContent.trim();
    }
    const inputEl = el as HTMLInputElement;
    return (
      (el as HTMLElement).innerText ||
      el.textContent ||
      inputEl.placeholder ||
      el.getAttribute('title') ||
      inputEl.name ||
      el.getAttribute('alt') ||
      ''
    )
      .replace(/[\r\n|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  };

  const getRole = (el: Element): string => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = ((el as HTMLInputElement).type || 'text').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button';
      if (t === 'checkbox' || t === 'radio') return t;
      return `textbox:${t}`;
    }
    return tag;
  };

  const title = (document.title || '').replace(/\s+/g, ' ').trim();
  const url = location.href || '';
  const rawHtmlLength = (document.documentElement?.outerHTML ?? '').length;

  const landmarks: SemanticLandmark[] = [];
  const seenLm = new Set<string>();
  for (const el of Array.from(
    document.querySelectorAll('header, nav, main, aside, footer, form, [role="banner"], [role="navigation"], [role="main"]'),
  )) {
    if (!isVisible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role')?.toLowerCase() ?? tag;
    const label = el.getAttribute('aria-label')?.trim() || undefined;
    const key = `${role}:${label ?? ''}`;
    if (!seenLm.has(key)) {
      seenLm.add(key);
      landmarks.push({ role, ...(label ? { label } : {}) });
    }
  }

  const outline: string[] = [];
  for (const h of Array.from(document.querySelectorAll('h1, h2, h3'))) {
    if (!isVisible(h)) continue;
    const txt = (h.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (txt && outline.length < 25) outline.push(`${h.tagName.toLowerCase()}: ${txt.slice(0, 120)}`);
  }

  const selector =
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"]';
  const rawEls: Element[] = [];
  const walkRoots = (root: ParentNode) => {
    for (const el of Array.from(root.querySelectorAll(selector))) rawEls.push(el);
    for (const host of Array.from(root.querySelectorAll('*'))) {
      const sr = (host as HTMLElement).shadowRoot;
      if (sr) walkRoots(sr);
    }
  };
  walkRoots(document);

  const interactiveNodes: SemanticNode[] = [];
  let nextId = 1;
  for (const el of rawEls) {
    if (!isVisible(el)) continue;
    if (interactiveNodes.length >= maxInteractiveNodes) break;
    const tag = el.tagName.toLowerCase();
    const inp = el as HTMLInputElement;
    const states: string[] = [];
    if ('disabled' in inp && inp.disabled) states.push('disabled');
    if ('checked' in inp && (inp.type === 'checkbox' || inp.type === 'radio')) {
      states.push(inp.checked ? 'checked' : 'unchecked');
    }
    let value: string | undefined;
    if (tag === 'input' && inp.type !== 'password' && inp.type !== 'checkbox' && inp.type !== 'radio' && inp.value) {
      value = inp.value.slice(0, 40);
      states.push(`val=${value}`);
    }
    const rect = el.getBoundingClientRect();
    const rawHref = tag === 'a' ? el.getAttribute('href') || '' : '';
    const href = includeLinks && rawHref && !rawHref.startsWith('javascript:') ? rawHref : undefined;
    interactiveNodes.push({
      nodeId: nextId++,
      role: getRole(el),
      name: getName(el),
      tag,
      state: states,
      ...(value ? { value } : {}),
      ...(href ? { href } : {}),
      cx: Math.round(rect.left + rect.width / 2),
      cy: Math.round(rect.top + rect.height / 2),
      locator: el.id ? `#${el.id}` : tag,
    });
  }

  const lines: string[] = [`# ${title || '(untitled)'}\nURL: ${url}`];
  if (landmarks.length > 0) {
    lines.push(`## Landmarks\n${landmarks.map((l) => (l.label ? `${l.role}("${l.label}")` : l.role)).join(', ')}`);
  }
  if (outline.length > 0) {
    lines.push(`## Outline\n${outline.map((o) => `- ${o}`).join('\n')}`);
  }
  if (interactiveNodes.length > 0) {
    lines.push(
      `## Interactive Elements\n${interactiveNodes
        .map((n) => `[${n.nodeId}] ${n.role} "${n.name || '-'}" (${n.state.join(',') || '-'})${n.href ? ` -> ${n.href}` : ''}`)
        .join('\n')}`,
    );
  }
  const compactText = lines.join('\n\n').slice(0, maxChars);

  return {
    title,
    url,
    landmarks,
    outline,
    interactiveNodes,
    forms: [],
    tables: [],
    viewportExcerpt: '',
    mainText: '',
    rawHtmlLength,
    compactText,
    compactCharCount: compactText.length,
    compressionRatio: rawHtmlLength > 0 ? Number((compactText.length / rawHtmlLength).toFixed(4)) : 1,
  };
}
