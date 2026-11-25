import { extractSemanticSnapshot } from '../extractors/semanticAom.js';
import type {
  InteractPageDiff,
  InteractPageInput,
  InteractPageResult,
  SemanticNode,
} from '../types.js';

export interface InteractPageOptions {
  /** Time in ms to wait for DOM mutations/async handlers to settle before diffing (default 35ms). */
  settleMs?: number;
  /** Allow typing into <input type="password"> fields (default false for safety). */
  allowPasswordInput?: boolean;
  /** Callback to approve high-risk actions (e.g., form submit or password input). */
  onApprovalRequired?: (reason: string, node?: SemanticNode) => Promise<boolean>;
}

export interface InteractExecutionOutcome {
  ok: boolean;
  requiresApproval?: boolean;
  error?: string;
  result?: InteractPageResult;
}

function collectTextSet(doc: Document): Set<string> {
  const texts = new Set<string>();
  const root = doc.body ?? doc.documentElement;
  if (!root) return texts;
  for (const el of Array.from(root.querySelectorAll('h1, h2, h3, p, li, div, span, td, [role="alert"], [role="status"]'))) {
    if (el.children.length > 0) continue;
    const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (t.length >= 2) {
      texts.add(t);
    }
  }
  return texts;
}

function computeDiff(
  beforeNodes: SemanticNode[],
  afterNodes: SemanticNode[],
  beforeTexts: Set<string>,
  afterTexts: Set<string>,
  urlBefore: string,
  urlAfter: string,
  titleBefore: string,
  titleAfter: string,
  settledMs: number,
): InteractPageDiff {
  const addedTexts: string[] = [];
  for (const t of afterTexts) {
    if (!beforeTexts.has(t)) {
      addedTexts.push(t);
      if (addedTexts.length >= 20) break;
    }
  }

  const removedTexts: string[] = [];
  for (const t of beforeTexts) {
    if (!afterTexts.has(t)) {
      removedTexts.push(t);
      if (removedTexts.length >= 20) break;
    }
  }

  const beforeMap = new Map<string, SemanticNode>();
  for (const n of beforeNodes) {
    beforeMap.set(`${n.locator}|${n.role}`, n);
  }

  const changedControls: InteractPageDiff['changedControls'] = [];
  for (const afterNode of afterNodes) {
    const prev = beforeMap.get(`${afterNode.locator}|${afterNode.role}`);
    if (!prev) continue;
    const prevState = prev.state.join(',') || '-';
    const nextState = afterNode.state.join(',') || '-';
    if (prevState !== nextState) {
      changedControls.push({
        nodeId: afterNode.nodeId,
        role: afterNode.role,
        name: afterNode.name,
        beforeState: prevState,
        afterState: nextState,
      });
    }
  }

  return {
    urlBefore,
    urlAfter,
    urlChanged: urlBefore !== urlAfter,
    titleChanged: titleBefore !== titleAfter,
    addedTexts,
    removedTexts,
    changedControls,
    settledMs,
  };
}

async function waitForSettle(doc: Document, settleMs: number): Promise<number> {
  const start = Date.now();
  const safeMs = Math.max(0, Math.min(2000, settleMs));
  if (safeMs === 0) {
    await Promise.resolve();
    return Date.now() - start;
  }

  await new Promise<void>((resolve) => {
    const win = doc.defaultView;
    const MutationObs = win?.MutationObserver ?? globalThis.MutationObserver;
    let settled = false;
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (quietTimer) clearTimeout(quietTimer);
      if (maxTimer) clearTimeout(maxTimer);
      observer?.disconnect();
      resolve();
    };

    maxTimer = setTimeout(finish, safeMs);
    quietTimer = setTimeout(finish, Math.min(15, safeMs));

    if (MutationObs && doc.body) {
      try {
        observer = new MutationObs(() => {
          if (quietTimer) clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, Math.min(15, safeMs));
        });
        observer.observe(doc.body, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      } catch {
        // Fallback to maxTimer
      }
    }
  });

  return Date.now() - start;
}

function setFormControlValue(el: Element, value: string): void {
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const proto =
      tag === 'input'
        ? el.ownerDocument.defaultView?.HTMLInputElement?.prototype
        : el.ownerDocument.defaultView?.HTMLTextAreaElement?.prototype;
    const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : undefined;
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      (el as HTMLInputElement).value = value;
    }
    return;
  }
  if ((el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true') {
    el.textContent = value;
  }
}

function dispatchInteractionEvent(doc: Document, el: Element, type: string, bubbles = true): void {
  const win = doc.defaultView;
  const EventCtor = win?.Event ?? globalThis.Event;
  if (EventCtor) {
    el.dispatchEvent(new EventCtor(type, { bubbles, cancelable: true }));
  }
}

/**
 * Executes a bounded DOM interaction (`interact_page`) targeting an assigned semantic node ID,
 * waits for DOM mutations to settle, and returns a compact diff + refreshed snapshot.
 */
export async function executePageInteraction(
  doc: Document,
  input: InteractPageInput,
  options?: InteractPageOptions,
): Promise<InteractExecutionOutcome> {
  const before = extractSemanticSnapshot(doc);
  const beforeTexts = collectTextSet(doc);
  const urlBefore = doc.location?.href || doc.URL || '';
  const titleBefore = doc.title || '';

  const win = doc.defaultView;

  if (input.action === 'scroll') {
    const amount = input.amount ?? 500;
    const dir = input.direction ?? 'down';
    if (input.node_id !== undefined) {
      const targetEl = before.elementMap.get(input.node_id);
      if (!targetEl) {
        return { ok: false, error: `Semantic node_id ${input.node_id} not found on page.` };
      }
      if (typeof (targetEl as HTMLElement).scrollIntoView === 'function') {
        (targetEl as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'center' });
      }
    } else if (win && typeof win.scrollBy === 'function') {
      try {
        if (dir === 'top') win.scrollTo?.(0, 0);
        else if (dir === 'bottom') win.scrollTo?.(0, doc.documentElement?.scrollHeight ?? 10000);
        else win.scrollBy(0, dir === 'up' ? -amount : amount);
      } catch {
        // JSDOM may throw "Not implemented: window.scrollTo"
      }
    }

    const settledMs = await waitForSettle(doc, options?.settleMs ?? 20);
    const after = extractSemanticSnapshot(doc);
    const afterTexts = collectTextSet(doc);
    const diff = computeDiff(
      before.snapshot.interactiveNodes,
      after.snapshot.interactiveNodes,
      beforeTexts,
      afterTexts,
      urlBefore,
      doc.location?.href || doc.URL || '',
      titleBefore,
      doc.title || '',
      settledMs,
    );
    return {
      ok: true,
      result: {
        action: 'scroll',
        ...(input.node_id !== undefined ? { targetNodeId: input.node_id } : {}),
        diff,
        snapshotCompact: after.snapshot.compactText,
      },
    };
  }

  if (input.node_id === undefined) {
    return { ok: false, error: `Action "${input.action}" requires a valid semantic node_id.` };
  }

  const targetEl = before.elementMap.get(input.node_id);
  const targetMeta = before.snapshot.interactiveNodes.find((n) => n.nodeId === input.node_id);
  if (!targetEl || !targetMeta) {
    return { ok: false, error: `Semantic node_id ${input.node_id} not found on page.` };
  }

  if (targetMeta.state.includes('disabled')) {
    return {
      ok: false,
      error: `Element [${input.node_id}] (${targetMeta.role} "${targetMeta.name}") is disabled.`,
    };
  }

  // Block dangerous javascript: URLs
  if (targetEl.tagName.toLowerCase() === 'a') {
    const href = (targetEl.getAttribute('href') ?? '').trim().toLowerCase();
    if (href.startsWith('javascript:') || href.startsWith('vbscript:')) {
      return { ok: false, error: 'Blocked unsafe javascript:/vbscript: link activation.' };
    }
  }

  // Safety gating on password inputs & form submissions when approval hook is configured
  const isPasswordField =
    targetEl.tagName.toLowerCase() === 'input' &&
    ((targetEl as HTMLInputElement).type || '').toLowerCase() === 'password';
  if (isPasswordField && !options?.allowPasswordInput) {
    if (options?.onApprovalRequired) {
      const approved = await options.onApprovalRequired(
        'Typing into a password field requires explicit user approval.',
        targetMeta,
      );
      if (!approved) {
        return {
          ok: false,
          requiresApproval: true,
          error: 'Password field interaction requires explicit user approval.',
        };
      }
    } else {
      return {
        ok: false,
        requiresApproval: true,
        error: 'Blocked typing into password input without explicit approval.',
      };
    }
  }

  const isSubmitControl =
    input.submit === true ||
    (targetEl.tagName.toLowerCase() === 'button' &&
      ((targetEl as HTMLButtonElement).type || 'submit').toLowerCase() === 'submit' &&
      Boolean(targetEl.closest('form'))) ||
    (targetEl.tagName.toLowerCase() === 'input' &&
      ((targetEl as HTMLInputElement).type || '').toLowerCase() === 'submit');

  if (isSubmitControl && options?.onApprovalRequired) {
    const approved = await options.onApprovalRequired(
      `Submitting form via [${input.node_id}] "${targetMeta.name}" requires approval.`,
      targetMeta,
    );
    if (!approved) {
      return {
        ok: false,
        requiresApproval: true,
        error: 'Form submission requires explicit user approval.',
      };
    }
  }

  switch (input.action) {
    case 'focus': {
      (targetEl as HTMLElement).focus?.();
      dispatchInteractionEvent(doc, targetEl, 'focus', false);
      break;
    }

    case 'hover': {
      dispatchInteractionEvent(doc, targetEl, 'mouseover', true);
      dispatchInteractionEvent(doc, targetEl, 'mouseenter', false);
      break;
    }

    case 'click': {
      (targetEl as HTMLElement).focus?.();
      if (typeof (targetEl as HTMLElement).click === 'function') {
        (targetEl as HTMLElement).click();
      } else {
        dispatchInteractionEvent(doc, targetEl, 'click', true);
      }
      break;
    }

    case 'type': {
      const text = input.text ?? '';
      const clearFirst = input.clear ?? true;
      (targetEl as HTMLElement).focus?.();
      const existing = (targetEl as HTMLInputElement).value ?? targetEl.textContent ?? '';
      const nextVal = clearFirst ? text : `${existing}${text}`;
      setFormControlValue(targetEl, nextVal);
      dispatchInteractionEvent(doc, targetEl, 'input', true);
      dispatchInteractionEvent(doc, targetEl, 'change', true);
      if (input.submit) {
        const form = targetEl.closest('form');
        if (form) {
          if (typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else {
            dispatchInteractionEvent(doc, form, 'submit', true);
          }
        }
      }
      break;
    }

    case 'select': {
      if (targetEl.tagName.toLowerCase() !== 'select') {
        return {
          ok: false,
          error: `Element [${input.node_id}] is <${targetEl.tagName.toLowerCase()}>, not <select>.`,
        };
      }
      const sel = targetEl as HTMLSelectElement;
      const wanted = (input.value ?? '').trim();
      const matchedOpt = Array.from(sel.options).find(
        (o) => o.value === wanted || o.text.trim() === wanted || o.text.trim().toLowerCase() === wanted.toLowerCase(),
      );
      if (!matchedOpt) {
        return {
          ok: false,
          error: `Option "${wanted}" not found in <select> [${input.node_id}].`,
        };
      }
      sel.value = matchedOpt.value;
      matchedOpt.selected = true;
      dispatchInteractionEvent(doc, sel, 'input', true);
      dispatchInteractionEvent(doc, sel, 'change', true);
      break;
    }

    case 'check': {
      const inp = targetEl as HTMLInputElement;
      const type = (inp.type || '').toLowerCase();
      if (targetEl.tagName.toLowerCase() !== 'input' || (type !== 'checkbox' && type !== 'radio')) {
        return {
          ok: false,
          error: `Element [${input.node_id}] is not a checkbox or radio input.`,
        };
      }
      const nextChecked = input.checked !== undefined ? input.checked : !inp.checked;
      inp.checked = nextChecked;
      dispatchInteractionEvent(doc, inp, 'input', true);
      dispatchInteractionEvent(doc, inp, 'change', true);
      break;
    }
  }

  const settledMs = await waitForSettle(doc, options?.settleMs ?? 35);
  const after = extractSemanticSnapshot(doc);
  const afterTexts = collectTextSet(doc);
  const diff = computeDiff(
    before.snapshot.interactiveNodes,
    after.snapshot.interactiveNodes,
    beforeTexts,
    afterTexts,
    urlBefore,
    doc.location?.href || doc.URL || '',
    titleBefore,
    doc.title || '',
    settledMs,
  );

  return {
    ok: true,
    result: {
      action: input.action,
      targetNodeId: input.node_id,
      targetRole: targetMeta.role,
      targetName: targetMeta.name,
      diff,
      snapshotCompact: after.snapshot.compactText,
    },
  };
}

/**
 * Formats an InteractPageResult into a concise LLM-readable summary.
 */
export function formatInteractResult(res: InteractPageResult): string {
  const lines: string[] = [];
  const targetLabel =
    res.targetNodeId !== undefined
      ? `[${res.targetNodeId}] ${res.targetRole ?? ''} "${res.targetName ?? ''}"`.trim()
      : 'viewport';
  lines.push(`Action: ${res.action} on ${targetLabel} (settled in ${res.diff.settledMs}ms)`);

  if (res.diff.urlChanged) {
    lines.push(`URL changed: ${res.diff.urlBefore} -> ${res.diff.urlAfter}`);
  }
  if (res.diff.titleChanged) {
    lines.push('Page title updated.');
  }
  if (res.diff.changedControls.length > 0) {
    lines.push(
      `Changed controls:\n${res.diff.changedControls
        .map((c) => `- [${c.nodeId}] ${c.role} "${c.name}": ${c.beforeState} -> ${c.afterState}`)
        .join('\n')}`,
    );
  }
  if (res.diff.addedTexts.length > 0) {
    lines.push(`Added text:\n${res.diff.addedTexts.map((t) => `+ ${t}`).join('\n')}`);
  }
  if (res.diff.removedTexts.length > 0) {
    lines.push(`Removed text:\n${res.diff.removedTexts.map((t) => `- ${t}`).join('\n')}`);
  }

  lines.push(`\n${res.snapshotCompact}`);
  return lines.join('\n');
}

/**
 * Self-contained interaction script injected via `chrome.scripting.executeScript`.
 * IMPORTANT: Never references outer-scope helpers or variables.
 */
export function inPageInteractScript(input: InteractPageInput): InteractExecutionOutcome {
  const start = Date.now();
  const selector =
    'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="textbox"], [role="checkbox"], [role="radio"], [role="combobox"]';

  const isVisible = (el: Element): boolean => {
    const htmlEl = el as HTMLElement;
    if (htmlEl.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const st = window.getComputedStyle(htmlEl);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const rect = htmlEl.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const collectInteractive = (): Element[] => {
    const out: Element[] = [];
    const walk = (root: ParentNode) => {
      for (const el of Array.from(root.querySelectorAll(selector))) {
        if (isVisible(el)) out.push(el);
      }
      for (const host of Array.from(root.querySelectorAll('*'))) {
        const sr = (host as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    walk(document);
    return out;
  };

  const urlBefore = location.href;
  const titleBefore = document.title;

  try {
    if (input.action === 'scroll') {
      const amount = input.amount ?? 500;
      const dir = input.direction ?? 'down';
      if (input.node_id !== undefined) {
        const nodes = collectInteractive();
        const el = nodes[input.node_id - 1];
        if (!el) return { ok: false, error: `Semantic node_id ${input.node_id} not found.` };
        (el as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'center' });
      } else if (dir === 'top') {
        window.scrollTo(0, 0);
      } else if (dir === 'bottom') {
        window.scrollTo(0, document.documentElement.scrollHeight);
      } else {
        window.scrollBy(0, dir === 'up' ? -amount : amount);
      }

      return {
        ok: true,
        result: {
          action: 'scroll',
          ...(input.node_id !== undefined ? { targetNodeId: input.node_id } : {}),
          diff: {
            urlBefore,
            urlAfter: location.href,
            urlChanged: urlBefore !== location.href,
            titleChanged: titleBefore !== document.title,
            addedTexts: [],
            removedTexts: [],
            changedControls: [],
            settledMs: Date.now() - start,
          },
          snapshotCompact: `# ${document.title}\nURL: ${location.href}`,
        },
      };
    }

    if (input.node_id === undefined) {
      return { ok: false, error: `Action "${input.action}" requires node_id.` };
    }

    const nodes = collectInteractive();
    const el = nodes[input.node_id - 1];
    if (!el) {
      return { ok: false, error: `Semantic node_id ${input.node_id} not found.` };
    }

    const htmlEl = el as HTMLElement;
    const inp = el as HTMLInputElement;
    if (inp.disabled || el.getAttribute('aria-disabled') === 'true') {
      return { ok: false, error: `Element [${input.node_id}] is disabled.` };
    }

    if (el.tagName.toLowerCase() === 'input' && (inp.type || '').toLowerCase() === 'password') {
      return {
        ok: false,
        requiresApproval: true,
        error: 'Blocked typing into password input without explicit approval.',
      };
    }

    if (input.action === 'click') {
      htmlEl.focus?.();
      htmlEl.click();
    } else if (input.action === 'focus') {
      htmlEl.focus?.();
    } else if (input.action === 'hover') {
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    } else if (input.action === 'type') {
      htmlEl.focus?.();
      const val = input.clear === false ? `${inp.value ?? ''}${input.text ?? ''}` : (input.text ?? '');
      inp.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (input.submit) {
        el.closest('form')?.requestSubmit();
      }
    } else if (input.action === 'select') {
      const sel = el as HTMLSelectElement;
      const opt = Array.from(sel.options).find(
        (o) => o.value === input.value || o.text.trim() === (input.value ?? '').trim(),
      );
      if (!opt) return { ok: false, error: `Option "${input.value}" not found.` };
      sel.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (input.action === 'check') {
      inp.checked = input.checked !== undefined ? input.checked : !inp.checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    return {
      ok: true,
      result: {
        action: input.action,
        targetNodeId: input.node_id,
        targetRole: el.getAttribute('role') || el.tagName.toLowerCase(),
        targetName: (el.getAttribute('aria-label') || htmlEl.innerText || inp.name || '').trim().slice(0, 80),
        diff: {
          urlBefore,
          urlAfter: location.href,
          urlChanged: urlBefore !== location.href,
          titleChanged: titleBefore !== document.title,
          addedTexts: [],
          removedTexts: [],
          changedControls: [],
          settledMs: Date.now() - start,
        },
        snapshotCompact: `# ${document.title}\nURL: ${location.href}`,
      },
    };
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
