import { formatInteractResult } from '../actions/interactPage.js';
import { validateCanonicalToolCall } from '../schemas/aliases.js';
import { getToolDefinition } from '../schemas/registry.js';
import { rankPassagesBm25 } from '../search/bm25Ranker.js';
import type {
  CanonicalToolName,
  ExtractedPageContent,
  FetchedSourceResult,
  InteractPageInput,
  InteractPageResult,
  MemoryHit,
  MemoryProvider,
  MemoryQuery,
  MemoryRecord,
  MemoryRecordInput,
  MemoryTier,
  OpenTabInfo,
  PageExtractMode,
  QuickJsRuntimeAdapter,
  ReadDocumentInput,
  ReadDocumentResult,
  RunSandboxInput,
  RunSandboxResult,
  ToolDefinition,
  ToolExecutionResult,
  ToolInvocationContext,
  WebSearchResult,
} from '../types.js';

export interface ReadPageAdapterOptions {
  mode: PageExtractMode;
  max_chars: number;
  include_links: boolean;
  query?: string;
}

export interface SearchWebAdapterOptions {
  max_results: number;
  read_top_n?: number;
}

export interface FetchBackgroundAdapterOptions {
  urls: string[];
  query?: string;
  max_chars: number;
}

export interface AdapterOutcome<T> {
  ok: boolean;
  data?: T;
  formatted?: string;
  sourceOrigin?: string;
  error?: string;
  needsPermission?: boolean;
  requiresApproval?: boolean;
  blockedByCaptcha?: boolean;
  manualUrl?: string;
}

/**
 * Unified Dual-Environment Adapter Contract implemented identically by
 * `ChromeExtensionAdapter` (Chromium MV3) and `WebDemoAdapter` (yours.sh demos).
 */
export interface ToolHostAdapter {
  readonly environment: ToolInvocationContext['environment'];

  listTabs(windowScope: 'current' | 'all', ctx: ToolInvocationContext): Promise<AdapterOutcome<OpenTabInfo[]>>;

  readActiveTab(
    options: ReadPageAdapterOptions,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ExtractedPageContent>>;

  readTab(
    tabId: number,
    options: ReadPageAdapterOptions,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ExtractedPageContent>>;

  interactPage(
    input: InteractPageInput,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<InteractPageResult>>;

  readDocument(
    input: ReadDocumentInput,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<ReadDocumentResult>>;

  runSandbox(
    input: RunSandboxInput,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<RunSandboxResult>>;

  searchWebTab(
    query: string,
    options: SearchWebAdapterOptions,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<WebSearchResult>>;

  fetchBackgroundTab(
    options: FetchBackgroundAdapterOptions,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<FetchedSourceResult[]>>;

  memoryRecall?(
    query: MemoryQuery,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<MemoryHit[]>>;

  memorySave?(
    input: MemoryRecordInput,
    ctx: ToolInvocationContext,
  ): Promise<AdapterOutcome<MemoryRecord>>;
}

export interface ToolPolicyDecision {
  verdict: 'allow' | 'require_approval' | 'deny';
  reason?: string;
}

export interface ToolRuntimeConfig {
  memoryProvider?: MemoryProvider;
  quickJsAdapter?: QuickJsRuntimeAdapter;
  /** Optional policy hook (e.g., @yours/guard integration). */
  evaluatePolicy?: (tool: ToolDefinition, args: Record<string, unknown>, ctx: ToolInvocationContext) => Promise<ToolPolicyDecision> | ToolPolicyDecision;
  /** Optional interactive approval handler for consequential actions. */
  onApprovalRequired?: (tool: ToolDefinition, args: Record<string, unknown>, reason: string) => Promise<boolean>;
}

/**
 * Lightweight built-in in-memory `MemoryProvider` for zero-setup web demos and tests.
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  private readonly records = new Map<string, MemoryRecord>();
  private seq = 1;

  async remember(input: MemoryRecordInput): Promise<MemoryRecord> {
    const now = Date.now();
    const id = `mem_${this.seq++}`;
    const record: MemoryRecord = {
      ...input,
      id,
      createdAt: now,
      updatedAt: now,
      lastAccessedAt: now,
      accessCount: 1,
    };
    this.records.set(id, record);
    return record;
  }

  async recall(query: MemoryQuery): Promise<MemoryHit[]> {
    const limit = query.limit ?? 5;
    const minScore = query.minScore ?? 0;
    const now = query.nowMs ?? Date.now();
    const tierSet = query.tiers && query.tiers.length > 0 ? new Set(query.tiers) : null;
    const qTokens = new Set((query.query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1));

    const hits: MemoryHit[] = [];
    for (const rec of this.records.values()) {
      if (tierSet && !tierSet.has(rec.tier)) continue;
      const contentTokens = new Set((rec.content.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1));
      const tagTokens = (rec.tags ?? []).map((t) => t.toLowerCase());
      let matches = 0;
      for (const qt of qTokens) {
        if (contentTokens.has(qt) || tagTokens.includes(qt)) matches++;
      }
      const lexicalScore = qTokens.size > 0 ? matches / qTokens.size : 0;
      const ageHours = Math.max(0, (now - rec.updatedAt) / 3_600_000);
      const recencyWeight = 1 / (1 + ageHours / 24);
      const importance = rec.importance ?? 0.5;
      const score = Number((lexicalScore * 0.75 + recencyWeight * 0.15 + importance * 0.1).toFixed(4));
      if (lexicalScore > 0 && score >= minScore) {
        rec.lastAccessedAt = now;
        rec.accessCount += 1;
        hits.push({ record: rec, score, bm25Rank: lexicalScore, recencyWeight });
      }
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  async inspect(filter?: { tier?: MemoryTier; limit?: number; offset?: number }): Promise<MemoryRecord[]> {
    let list = Array.from(this.records.values());
    if (filter?.tier) list = list.filter((r) => r.tier === filter.tier);
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? list.length;
    return list.slice(offset, offset + limit);
  }

  async forget(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

function safeOriginFromUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}

function formatPageResponse(page: ExtractedPageContent, maxChars: number, query?: string): string {
  const searchable = page.fullContent || page.content;
  if (query && query.trim()) {
    const ranked = rankPassagesBm25(searchable, query.trim(), maxChars);
    return `[${page.mode.toUpperCase()}: MATCHED FOR "${query.trim()}"] ${page.title}\nURL: ${page.url}\n\n${ranked.excerpt}`;
  }
  return `[${page.mode.toUpperCase()}] ${page.title}\nURL: ${page.url}\n\n${page.content}`;
}

/**
 * Unified Tool Runtime dispatching canonical and legacy tool calls across any `ToolHostAdapter`.
 */
export class ToolRuntime {
  constructor(
    private readonly adapter: ToolHostAdapter,
    private readonly config: ToolRuntimeConfig = {},
  ) {}

  async execute(
    rawCall: { name: string; arguments?: Record<string, unknown> },
    partialCtx?: Partial<ToolInvocationContext>,
  ): Promise<ToolExecutionResult> {
    const ctx: ToolInvocationContext = {
      environment: partialCtx?.environment ?? this.adapter.environment,
      sessionId: partialCtx?.sessionId ?? 'default-session',
      ...(partialCtx?.origin ? { origin: partialCtx.origin } : {}),
      ...(partialCtx?.abortSignal ? { abortSignal: partialCtx.abortSignal } : {}),
    };

    const validation = validateCanonicalToolCall({
      name: rawCall.name,
      arguments: rawCall.arguments ?? {},
    });

    if (!validation.valid || !validation.normalized) {
      return {
        ok: false,
        toolName: 'read_active_tab',
        formatted: '',
        tainted: false,
        error: validation.error ?? 'Invalid tool call.',
      };
    }

    const call = validation.normalized;
    const def = getToolDefinition(call.name);
    const args = call.arguments;

    if (this.config.evaluatePolicy) {
      const decision = await this.config.evaluatePolicy(def, args, ctx);
      if (decision.verdict === 'deny') {
        return {
          ok: false,
          toolName: call.name,
          formatted: '',
          tainted: false,
          error: decision.reason ?? `Tool "${call.name}" denied by security policy.`,
        };
      }
      if (decision.verdict === 'require_approval') {
        const approved = this.config.onApprovalRequired
          ? await this.config.onApprovalRequired(def, args, decision.reason ?? 'Approval required.')
          : false;
        if (!approved) {
          return {
            ok: false,
            toolName: call.name,
            formatted: '',
            tainted: false,
            requiresApproval: true,
            error: decision.reason ?? `Tool "${call.name}" requires explicit user approval.`,
          };
        }
      }
    }

    switch (call.name) {
      case 'list_tabs': {
        const scope = (args.window_scope as 'current' | 'all') ?? 'current';
        const outcome = await this.adapter.listTabs(scope, ctx);
        const tabs = outcome.data ?? [];
        const formatted =
          outcome.formatted ??
          (tabs.length === 0
            ? 'No open tabs found.'
            : tabs
                .map((t) => `[${t.id}]${t.active ? ' *active*' : ''} ${t.title || '(untitled)'} — ${t.url}`)
                .join('\n'));
        return {
          ok: outcome.ok,
          toolName: 'list_tabs',
          data: tabs,
          formatted,
          tainted: def.safety.untrustedContentHint && outcome.ok,
          ...(outcome.error ? { error: outcome.error } : {}),
        };
      }

      case 'read_active_tab': {
        const maxChars = (args.max_chars as number) ?? 8000;
        const query = typeof args.query === 'string' ? args.query : undefined;
        const outcome = await this.adapter.readActiveTab(
          {
            mode: (args.mode as PageExtractMode) ?? 'auto',
            max_chars: maxChars,
            include_links: Boolean(args.include_links),
            query,
          },
          ctx,
        );
        const page = outcome.data;
        if (!outcome.ok || !page) {
          return {
            ok: false,
            toolName: 'read_active_tab',
            data: page,
            formatted: outcome.formatted ?? '',
            tainted: Boolean(page),
            error: outcome.error ?? 'Failed to read active tab.',
          };
        }
        return {
          ok: true,
          toolName: 'read_active_tab',
          data: page,
          formatted: outcome.formatted ?? formatPageResponse(page, maxChars, query),
          tainted: true,
          sourceOrigin: outcome.sourceOrigin ?? safeOriginFromUrl(page.url),
        };
      }

      case 'read_tab': {
        const tabId = args.tab_id as number;
        const maxChars = (args.max_chars as number) ?? 8000;
        const query = typeof args.query === 'string' ? args.query : undefined;
        const outcome = await this.adapter.readTab(
          tabId,
          {
            mode: (args.mode as PageExtractMode) ?? 'auto',
            max_chars: maxChars,
            include_links: Boolean(args.include_links),
            query,
          },
          ctx,
        );
        const page = outcome.data;
        if (!outcome.ok || !page) {
          return {
            ok: false,
            toolName: 'read_tab',
            data: page,
            formatted: outcome.formatted ?? '',
            tainted: Boolean(page),
            error: outcome.error ?? `Failed to read tab ${tabId}.`,
          };
        }
        return {
          ok: true,
          toolName: 'read_tab',
          data: page,
          formatted: outcome.formatted ?? formatPageResponse(page, maxChars, query),
          tainted: true,
          sourceOrigin: outcome.sourceOrigin ?? safeOriginFromUrl(page.url),
        };
      }

      case 'interact_page': {
        const outcome = await this.adapter.interactPage(args as unknown as InteractPageInput, ctx);
        if (!outcome.ok || !outcome.data) {
          return {
            ok: false,
            toolName: 'interact_page',
            formatted: outcome.formatted ?? '',
            tainted: true,
            ...(outcome.requiresApproval ? { requiresApproval: true } : {}),
            error: outcome.error ?? 'Page interaction failed.',
          };
        }
        return {
          ok: true,
          toolName: 'interact_page',
          data: outcome.data,
          formatted: outcome.formatted ?? formatInteractResult(outcome.data),
          tainted: true,
          sourceOrigin: outcome.sourceOrigin ?? safeOriginFromUrl(outcome.data.diff.urlAfter),
        };
      }

      case 'run_sandbox': {
        const outcome = await this.adapter.runSandbox(args as unknown as RunSandboxInput, ctx);
        const res = outcome.data;
        const formatted =
          outcome.formatted ||
          res?.formatted ||
          (outcome.ok ? '' : `Error: ${outcome.error ?? res?.error ?? 'Sandbox execution failed.'}`);
        return {
          ok: outcome.ok,
          toolName: 'run_sandbox',
          data: res,
          formatted,
          tainted: false,
          ...(outcome.error ? { error: outcome.error } : res?.error ? { error: res.error } : {}),
        };
      }

      case 'read_document': {
        const outcome = await this.adapter.readDocument(args as unknown as ReadDocumentInput, ctx);
        const doc = outcome.data;
        if (!outcome.ok || !doc) {
          return {
            ok: false,
            toolName: 'read_document',
            formatted: outcome.formatted ?? '',
            tainted: true,
            error: outcome.error ?? 'Failed to read document.',
          };
        }
        const header = `[DOCUMENT: ${doc.metadata.format.toUpperCase()}]${doc.metadata.title ? ` ${doc.metadata.title}` : ''} (pages=${doc.metadata.pageCount}, chars=${doc.metadata.charCount})`;
        return {
          ok: true,
          toolName: 'read_document',
          data: doc,
          formatted: outcome.formatted ?? `${header}\n\n${doc.content}`,
          tainted: true,
        };
      }

      case 'search_web_tab': {
        const query = args.query as string;
        const maxResults = (args.max_results as number) ?? 5;
        const readTopN = args.read_top_n as number | undefined;
        const outcome = await this.adapter.searchWebTab(
          query,
          { max_results: maxResults, read_top_n: readTopN },
          ctx,
        );
        return {
          ok: outcome.ok,
          toolName: 'search_web_tab',
          data: outcome.data,
          formatted: outcome.formatted ?? '',
          tainted: true,
          ...(outcome.needsPermission ? { needsPermission: true } : {}),
          ...(outcome.blockedByCaptcha ? { blockedByCaptcha: true, manualUrl: outcome.manualUrl } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        };
      }

      case 'fetch_background_tab': {
        const urls = (args.urls as string[]) ?? [args.url as string];
        const maxChars = (args.max_chars as number) ?? 4000;
        const query = typeof args.query === 'string' ? args.query : undefined;
        const outcome = await this.adapter.fetchBackgroundTab(
          { urls, query, max_chars: maxChars },
          ctx,
        );
        return {
          ok: outcome.ok,
          toolName: 'fetch_background_tab',
          data: outcome.data,
          formatted: outcome.formatted ?? '',
          tainted: true,
          sourceOrigin: outcome.sourceOrigin ?? safeOriginFromUrl(urls[0]),
          ...(outcome.needsPermission ? { needsPermission: true } : {}),
          ...(outcome.blockedByCaptcha ? { blockedByCaptcha: true, manualUrl: outcome.manualUrl } : {}),
          ...(outcome.error ? { error: outcome.error } : {}),
        };
      }

      case 'memory_recall': {
        const queryInput: MemoryQuery = {
          query: args.query as string,
          ...(Array.isArray(args.tiers) ? { tiers: args.tiers as MemoryTier[] } : {}),
          limit: (args.limit as number) ?? 5,
          minScore: (args.min_score as number) ?? 0,
        };

        if (this.config.memoryProvider) {
          const hits = await this.config.memoryProvider.recall(queryInput);
          const anyTainted = hits.some((h) => Boolean(h.record.tainted));
          const formatted =
            hits.length === 0
              ? 'No matching memories found.'
              : hits
                  .map(
                    (h, idx) =>
                      `${idx + 1}. [${h.record.tier}] (score=${h.score.toFixed(2)}) ${h.record.content}`,
                  )
                  .join('\n');
          return {
            ok: true,
            toolName: 'memory_recall',
            data: hits,
            formatted,
            tainted: anyTainted,
          };
        }

        if (this.adapter.memoryRecall) {
          const outcome = await this.adapter.memoryRecall(queryInput, ctx);
          const hits = outcome.data ?? [];
          const anyTainted = hits.some((h) => Boolean(h.record.tainted));
          return {
            ok: outcome.ok,
            toolName: 'memory_recall',
            data: hits,
            formatted: outcome.formatted ?? '',
            tainted: anyTainted,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        }

        return {
          ok: false,
          toolName: 'memory_recall',
          formatted: '',
          tainted: false,
          error: 'No MemoryProvider configured for memory_recall.',
        };
      }

      case 'memory_save': {
        const recordInput: MemoryRecordInput = {
          tier: (args.tier as MemoryTier) ?? 'episodic',
          content: args.content as string,
          ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
          importance: (args.importance as number) ?? 0.7,
          ...(typeof args.source_url === 'string' ? { sourceUrl: args.source_url } : {}),
          ...(typeof args.source_title === 'string' ? { sourceTitle: args.source_title } : {}),
        };

        if (this.config.memoryProvider) {
          const saved = await this.config.memoryProvider.remember(recordInput);
          return {
            ok: true,
            toolName: 'memory_save',
            data: saved,
            formatted: `Saved memory [${saved.id}] in tier "${saved.tier}".`,
            tainted: false,
          };
        }

        if (this.adapter.memorySave) {
          const outcome = await this.adapter.memorySave(recordInput, ctx);
          return {
            ok: outcome.ok,
            toolName: 'memory_save',
            data: outcome.data,
            formatted: outcome.formatted ?? '',
            tainted: false,
            ...(outcome.error ? { error: outcome.error } : {}),
          };
        }

        return {
          ok: false,
          toolName: 'memory_save',
          formatted: '',
          tainted: false,
          error: 'No MemoryProvider configured for memory_save.',
        };
      }
    }
  }
}

export function createToolRuntime(
  adapter: ToolHostAdapter,
  config?: ToolRuntimeConfig,
): ToolRuntime {
  return new ToolRuntime(adapter, config);
}

export type { CanonicalToolName };
