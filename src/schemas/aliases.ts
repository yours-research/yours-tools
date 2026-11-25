import type {
  CanonicalToolName,
  LegacyToolAlias,
  PageExtractMode,
  ParsedToolCall,
  SandboxMode,
} from '../types.js';
import { CANONICAL_TOOL_MAP } from './registry.js';

export const LEGACY_TOOL_ALIASES: Readonly<Record<LegacyToolAlias, CanonicalToolName>> = {
  read_active_page: 'read_active_tab',
  list_open_tabs: 'list_tabs',
  web_search: 'search_web_tab',
  fetch_and_read_url: 'fetch_background_tab',
  js_calc: 'run_sandbox',
};

export const TOOL_UI_LABELS: Readonly<Record<CanonicalToolName, string>> = {
  read_active_tab: 'Reading active tab...',
  list_tabs: 'Checking open tabs...',
  read_tab: 'Reading tab...',
  interact_page: 'Interacting with page...',
  run_sandbox: 'Running sandbox compute...',
  read_document: 'Reading document...',
  search_web_tab: 'Searching the web...',
  fetch_background_tab: 'Reading background source...',
  memory_recall: 'Recalling memory...',
  memory_save: 'Saving memory...',
};

const VALID_PAGE_MODES = new Set<PageExtractMode>(['auto', 'article', 'selection', 'interactive', 'aom']);
const VALID_SANDBOX_MODES = new Set<SandboxMode>(['expr', 'unit', 'date', 'json', 'csv', 'transform', 'js']);
const VALID_INTERACT_ACTIONS = new Set(['click', 'type', 'select', 'check', 'scroll', 'focus', 'hover']);
const VALID_DOC_FORMATS = new Set(['auto', 'pdf', 'markdown', 'html', 'csv', 'txt', 'json']);
const VALID_MEMORY_TIERS = new Set(['working', 'profile', 'episodic', 'document']);

export function resolveToolAlias(name: string): CanonicalToolName | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return null;
  }
  if (CANONICAL_TOOL_MAP.has(trimmed as CanonicalToolName)) {
    return trimmed as CanonicalToolName;
  }
  const mapped = LEGACY_TOOL_ALIASES[trimmed as LegacyToolAlias];
  return mapped ?? null;
}

export function isLegacyToolAlias(name: string): name is LegacyToolAlias {
  return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_ALIASES, name.trim());
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    value = Number.parseInt(value.trim(), 10);
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())) {
    value = Number.parseFloat(value.trim());
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/**
 * Normalizes canonical and legacy parameter keys into canonical v1.1 arguments.
 */
export function normalizeToolArguments(
  canonicalName: CanonicalToolName,
  rawArgs: Record<string, unknown>,
): Record<string, unknown> {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};

  switch (canonicalName) {
    case 'read_active_tab': {
      const includeLinks = toBoolean(args.include_links ?? args.includeLinks, false);
      const maxChars = clampInt(args.max_chars ?? args.maxChars, 500, 120000, 24000);
      const rawMode = args.mode;
      const mode =
        typeof rawMode === 'string' && VALID_PAGE_MODES.has(rawMode as PageExtractMode)
          ? rawMode
          : 'auto';
      const out: Record<string, unknown> = {
        include_links: includeLinks,
        max_chars: maxChars,
        mode,
      };
      if (typeof args.query === 'string' && args.query.trim()) {
        out.query = args.query.trim();
      }
      return out;
    }

    case 'list_tabs': {
      const scopeRaw = args.window_scope ?? args.windowScope;
      const windowScope = scopeRaw === 'all' ? 'all' : 'current';
      return { window_scope: windowScope };
    }

    case 'read_tab': {
      const rawTabId = args.tab_id ?? args.tabId;
      const tabId =
        typeof rawTabId === 'string' && /^\d+$/.test(rawTabId.trim())
          ? Number.parseInt(rawTabId.trim(), 10)
          : rawTabId;
      const maxChars = clampInt(args.max_chars ?? args.maxChars, 500, 120000, 24000);
      const includeLinks = toBoolean(args.include_links ?? args.includeLinks, false);
      const rawMode = args.mode;
      const mode =
        typeof rawMode === 'string' && VALID_PAGE_MODES.has(rawMode as PageExtractMode)
          ? rawMode
          : 'auto';
      const out: Record<string, unknown> = {
        tab_id: tabId,
        max_chars: maxChars,
        mode,
        include_links: includeLinks,
      };
      if (typeof args.query === 'string' && args.query.trim()) {
        out.query = args.query.trim();
      }
      return out;
    }

    case 'interact_page': {
      const out: Record<string, unknown> = {
        action: typeof args.action === 'string' ? args.action.trim().toLowerCase() : args.action,
      };
      const rawNodeId = args.node_id ?? args.nodeId;
      if (rawNodeId !== undefined) {
        out.node_id =
          typeof rawNodeId === 'string' && /^\d+$/.test(rawNodeId.trim())
            ? Number.parseInt(rawNodeId.trim(), 10)
            : rawNodeId;
      }
      if (typeof args.text === 'string') out.text = args.text;
      if (args.value !== undefined) out.value = String(args.value);
      if (args.checked !== undefined) out.checked = toBoolean(args.checked, true);
      if (typeof args.direction === 'string') out.direction = args.direction.trim().toLowerCase();
      if (args.amount !== undefined) out.amount = clampInt(args.amount, 50, 5000, 500);
      const rawTabId = args.tab_id ?? args.tabId;
      if (rawTabId !== undefined) {
        out.tab_id =
          typeof rawTabId === 'string' && /^\d+$/.test(rawTabId.trim())
            ? Number.parseInt(rawTabId.trim(), 10)
            : rawTabId;
      }
      if (args.submit !== undefined) out.submit = toBoolean(args.submit, false);
      if (args.clear !== undefined) out.clear = toBoolean(args.clear, true);
      return out;
    }

    case 'run_sandbox': {
      const inferredMode =
        typeof args.mode === 'string'
          ? args.mode.trim().toLowerCase()
          : typeof args.code === 'string'
            ? 'js'
            : 'expr';
      const out: Record<string, unknown> = {
        ...args,
        mode: inferredMode,
        timeout_ms: clampInt(args.timeout_ms ?? args.timeoutMs, 10, 5000, 1000),
        memory_limit_bytes: clampInt(
          args.memory_limit_bytes ?? args.memoryLimitBytes,
          65536,
          33554432,
          8388608,
        ),
      };
      return out;
    }

    case 'read_document': {
      const rawFormat = typeof args.format === 'string' ? args.format.trim().toLowerCase() : 'auto';
      const format = VALID_DOC_FORMATS.has(rawFormat) ? rawFormat : 'auto';
      const maxChars = clampInt(args.max_chars ?? args.maxChars, 500, 120000, 24000);
      const out: Record<string, unknown> = {
        source: args.source,
        format,
        max_chars: maxChars,
      };
      if (typeof args.filename === 'string' && args.filename.trim()) out.filename = args.filename.trim();
      if (typeof args.query === 'string' && args.query.trim()) out.query = args.query.trim();
      const pageRange = args.page_range ?? args.pageRange;
      if (typeof pageRange === 'string' && pageRange.trim()) out.page_range = pageRange.trim();
      return out;
    }

    case 'search_web_tab': {
      const maxResults = clampInt(args.max_results ?? args.maxResults ?? args.limit, 1, 10, 5);
      const out: Record<string, unknown> = {
        query: typeof args.query === 'string' ? args.query.trim() : args.query,
        max_results: maxResults,
      };
      const readTopN = args.read_top_n ?? args.readTopN;
      if (readTopN !== undefined) {
        out.read_top_n = clampInt(readTopN, 0, 3, 2);
      }
      return out;
    }

    case 'fetch_background_tab': {
      const maxChars = clampInt(
        args.max_chars ?? args.maxChars ?? args.maxCharsPerSource,
        500,
        120000,
        24000,
      );
      const rawUrls = Array.isArray(args.urls)
        ? args.urls
            .filter((u): u is string => typeof u === 'string' && u.trim().length > 0)
            .map((u) => u.trim())
            .slice(0, 5)
        : undefined;
      const singleUrl = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : undefined;
      const out: Record<string, unknown> = {
        max_chars: maxChars,
      };
      if (singleUrl) {
        out.url = singleUrl;
      } else if (rawUrls && rawUrls.length > 0) {
        out.url = rawUrls[0];
      }
      if (rawUrls && rawUrls.length > 0) {
        out.urls = rawUrls;
      } else if (singleUrl) {
        out.urls = [singleUrl];
      }
      if (typeof args.query === 'string' && args.query.trim()) {
        out.query = args.query.trim();
      }
      return out;
    }

    case 'memory_recall': {
      const limit = clampInt(args.limit, 1, 20, 5);
      const minScore = clampNumber(args.min_score ?? args.minScore, 0, 1, 0);
      const out: Record<string, unknown> = {
        query: typeof args.query === 'string' ? args.query.trim() : args.query,
        limit,
        min_score: minScore,
      };
      if (Array.isArray(args.tiers)) {
        const tiers = args.tiers.filter(
          (t): t is string => typeof t === 'string' && VALID_MEMORY_TIERS.has(t),
        );
        if (tiers.length > 0) out.tiers = tiers;
      }
      return out;
    }

    case 'memory_save': {
      const rawTier = typeof args.tier === 'string' ? args.tier.trim().toLowerCase() : 'episodic';
      const tier = VALID_MEMORY_TIERS.has(rawTier) ? rawTier : 'episodic';
      const importance = clampNumber(args.importance, 0, 1, 0.7);
      const out: Record<string, unknown> = {
        content: typeof args.content === 'string' ? args.content.trim() : args.content,
        tier,
        importance,
      };
      if (Array.isArray(args.tags)) {
        out.tags = args.tags.filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
      }
      const sourceUrl = args.source_url ?? args.sourceUrl;
      const sourceTitle = args.source_title ?? args.sourceTitle;
      if (typeof sourceUrl === 'string' && sourceUrl.trim()) out.source_url = sourceUrl.trim();
      if (typeof sourceTitle === 'string' && sourceTitle.trim()) out.source_title = sourceTitle.trim();
      return out;
    }
  }
}

export function validateCanonicalToolCall(call: {
  id?: string;
  name: string;
  arguments?: Record<string, unknown>;
}): { valid: boolean; normalized?: ParsedToolCall; error?: string } {
  if (!call || typeof call.name !== 'string') {
    return { valid: false, error: 'Tool call must include a string "name".' };
  }

  const originalName = call.name.trim();
  const canonicalName = resolveToolAlias(originalName);
  if (!canonicalName) {
    return { valid: false, error: `Unknown tool name "${originalName}".` };
  }

  const normalizedArgs = normalizeToolArguments(canonicalName, call.arguments ?? {});

  switch (canonicalName) {
    case 'read_active_tab':
    case 'list_tabs':
      break;

    case 'read_tab': {
      const tabId = normalizedArgs.tab_id;
      if (typeof tabId !== 'number' || !Number.isInteger(tabId) || tabId < 1) {
        return { valid: false, error: 'read_tab requires a positive integer "tab_id".' };
      }
      break;
    }

    case 'interact_page': {
      const action = normalizedArgs.action;
      if (typeof action !== 'string' || !VALID_INTERACT_ACTIONS.has(action)) {
        return {
          valid: false,
          error: `interact_page requires a valid "action" (${Array.from(VALID_INTERACT_ACTIONS).join(', ')}).`,
        };
      }
      if (action !== 'scroll') {
        const nodeId = normalizedArgs.node_id;
        if (typeof nodeId !== 'number' || !Number.isInteger(nodeId) || nodeId < 1) {
          return { valid: false, error: `interact_page action "${action}" requires a positive integer "node_id".` };
        }
      }
      if (action === 'type' && typeof normalizedArgs.text !== 'string') {
        return { valid: false, error: 'interact_page action "type" requires string "text".' };
      }
      if (action === 'select' && typeof normalizedArgs.value !== 'string') {
        return { valid: false, error: 'interact_page action "select" requires string "value".' };
      }
      break;
    }

    case 'run_sandbox': {
      const mode = normalizedArgs.mode as string;
      if (!VALID_SANDBOX_MODES.has(mode as SandboxMode)) {
        return { valid: false, error: `Invalid run_sandbox mode "${mode}".` };
      }
      if (
        mode === 'expr' &&
        (typeof normalizedArgs.expression !== 'string' || !normalizedArgs.expression.trim())
      ) {
        return { valid: false, error: 'run_sandbox in "expr" mode requires a non-empty "expression".' };
      }
      if (
        mode === 'js' &&
        (typeof normalizedArgs.code !== 'string' || !normalizedArgs.code.trim()) &&
        (typeof normalizedArgs.expression !== 'string' || !normalizedArgs.expression.trim())
      ) {
        return { valid: false, error: 'run_sandbox in "js" mode requires non-empty "code".' };
      }
      break;
    }

    case 'read_document': {
      if (typeof normalizedArgs.source !== 'string' || !normalizedArgs.source.trim()) {
        return { valid: false, error: 'read_document requires a non-empty "source".' };
      }
      break;
    }

    case 'search_web_tab': {
      if (typeof normalizedArgs.query !== 'string' || !normalizedArgs.query.trim()) {
        return { valid: false, error: 'search_web_tab requires a non-empty string "query".' };
      }
      break;
    }

    case 'fetch_background_tab': {
      const urls = normalizedArgs.urls as string[] | undefined;
      const single = normalizedArgs.url as string | undefined;
      if ((!single || !/^https?:\/\//i.test(single)) && (!urls || urls.length === 0)) {
        return {
          valid: false,
          error: 'fetch_background_tab requires a valid http:// or https:// "url" (or "urls").',
        };
      }
      if (urls) {
        const validUrls = urls.filter((u) => /^https?:\/\//i.test(u));
        if (validUrls.length === 0) {
          return {
            valid: false,
            error: 'fetch_background_tab requires at least one http:// or https:// URL.',
          };
        }
        normalizedArgs.urls = validUrls;
        normalizedArgs.url = validUrls[0];
      }
      break;
    }

    case 'memory_recall': {
      if (typeof normalizedArgs.query !== 'string' || !normalizedArgs.query.trim()) {
        return { valid: false, error: 'memory_recall requires a non-empty string "query".' };
      }
      break;
    }

    case 'memory_save': {
      if (typeof normalizedArgs.content !== 'string' || !normalizedArgs.content.trim()) {
        return { valid: false, error: 'memory_save requires a non-empty string "content".' };
      }
      break;
    }
  }

  return {
    valid: true,
    normalized: {
      ...(call.id ? { id: call.id } : {}),
      name: canonicalName,
      originalName,
      arguments: normalizedArgs,
    },
  };
}
