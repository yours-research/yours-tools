/**
 * @yours/tools — Shared Ecosystem Contracts & Domain Types (Schema v1.1)
 */

export type CanonicalToolName =
  | 'read_active_tab'
  | 'list_tabs'
  | 'read_tab'
  | 'interact_page'
  | 'run_sandbox'
  | 'read_document'
  | 'search_web_tab'
  | 'fetch_background_tab'
  | 'memory_recall'
  | 'memory_save';

export type LegacyToolAlias =
  | 'read_active_page'
  | 'list_open_tabs'
  | 'web_search'
  | 'fetch_and_read_url'
  | 'js_calc';

export type AnyToolName = CanonicalToolName | LegacyToolAlias;

export interface ToolSafetyHints {
  /** True for pure reads/compute; false for state mutations. */
  readOnlyHint: boolean;
  /** True for form submit, click/type side-effects, memory writes, external requests. */
  consequentialHint: boolean;
  /** True only if live internet navigation/search is invoked. */
  networkHint: boolean;
  /** True when output embeds external/DOM/PDF text (requires IDPI spotlighting). */
  untrustedContentHint: boolean;
}

export interface ToolDefinition {
  name: CanonicalToolName;
  aliases?: string[];
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: false;
  };
  safety: ToolSafetyHints;
}

export interface ToolInvocationContext {
  environment: 'chrome-mv3' | 'web-demo' | 'node-test';
  sessionId: string;
  origin?: string;
  abortSignal?: AbortSignal;
}

export interface ToolExecutionResult<TData = unknown> {
  ok: boolean;
  toolName: CanonicalToolName;
  data?: TData;
  formatted: string;
  /** Propagated to @yours/guard for IDPI spotlighting. */
  tainted: boolean;
  sourceOrigin?: string;
  error?: string;
  needsPermission?: boolean;
  requiresApproval?: boolean;
  blockedByCaptcha?: boolean;
  manualUrl?: string;
}

export interface ParsedToolCall {
  id?: string;
  name: CanonicalToolName;
  originalName: string;
  arguments: Record<string, unknown>;
  raw?: string;
}

export interface PendingToolDetection {
  isOpen: boolean;
  toolName: CanonicalToolName | null;
  rawToolName: string | null;
  label: string;
}

export type PageExtractMode = 'auto' | 'article' | 'selection' | 'interactive' | 'aom';

export interface SemanticNode {
  nodeId: number;
  role: string;
  name: string;
  tag: string;
  state: string[];
  value?: string;
  href?: string;
  cx: number;
  cy: number;
  locator: string;
}

export interface SemanticLandmark {
  role: string;
  label?: string;
}

export interface SemanticTableSummary {
  caption?: string;
  headers: string[];
  rowCount: number;
  rows: string[][];
}

export interface SemanticFormSummary {
  id?: string;
  name?: string;
  action?: string;
  method?: string;
  fieldNodeIds: number[];
}

export interface SemanticSnapshot {
  title: string;
  url: string;
  landmarks: SemanticLandmark[];
  outline: string[];
  interactiveNodes: SemanticNode[];
  forms: SemanticFormSummary[];
  tables: SemanticTableSummary[];
  viewportExcerpt: string;
  mainText: string;
  rawHtmlLength: number;
  compactText: string;
  compactCharCount: number;
  compressionRatio: number;
}

export interface ExtractedPageContent {
  mode: 'article' | 'selection' | 'youtube' | 'pdf' | 'interactive' | 'aom';
  title: string;
  url: string;
  content: string;
  contentHash: string;
  charCount: number;
  truncated: boolean;
  error?: string;
  youtubeCaptionUrl?: string;
  youtubeLanguageCode?: string;
  fullContent?: string;
  outline?: string[];
  viewportExcerpt?: string;
  selectionText?: string;
  metadata?: Record<string, string>;
  links?: Array<{ text: string; url: string }>;
  semanticSnapshot?: SemanticSnapshot;
}

export interface OpenTabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
}

export type PageInteractionAction =
  | 'click'
  | 'type'
  | 'select'
  | 'check'
  | 'scroll'
  | 'focus'
  | 'hover';

export interface InteractPageInput {
  action: PageInteractionAction;
  node_id?: number;
  text?: string;
  value?: string;
  checked?: boolean;
  direction?: 'up' | 'down' | 'top' | 'bottom';
  amount?: number;
  tab_id?: number;
  submit?: boolean;
  clear?: boolean;
}

export interface InteractPageDiff {
  urlBefore: string;
  urlAfter: string;
  urlChanged: boolean;
  titleChanged: boolean;
  addedTexts: string[];
  removedTexts: string[];
  changedControls: Array<{
    nodeId: number;
    role: string;
    name: string;
    beforeState: string;
    afterState: string;
  }>;
  settledMs: number;
}

export interface InteractPageResult {
  action: PageInteractionAction;
  targetNodeId?: number;
  targetRole?: string;
  targetName?: string;
  diff: InteractPageDiff;
  snapshotCompact: string;
}

export type SandboxMode = 'expr' | 'unit' | 'date' | 'json' | 'csv' | 'transform' | 'js';

export interface RunSandboxInput {
  mode?: SandboxMode;
  expression?: string;
  code?: string;
  value?: unknown;
  from?: string;
  to?: string;
  dateA?: string;
  dateB?: string;
  days?: number;
  data?: unknown;
  path?: string;
  timeout_ms?: number;
  memory_limit_bytes?: number;
}

export interface RunSandboxResult {
  ok: boolean;
  mode: SandboxMode;
  engine: 'deterministic-ast' | 'quickjs-wasm';
  result?: unknown;
  formatted: string;
  elapsedMs: number;
  error?: string;
}

export interface QuickJsRuntimeAdapter {
  execute(
    code: string,
    options: {
      data?: unknown;
      timeoutMs: number;
      memoryLimitBytes: number;
    },
  ): Promise<{ ok: boolean; result?: unknown; stdout?: string; error?: string }>;
}

export type DocumentFormat = 'auto' | 'pdf' | 'markdown' | 'html' | 'csv' | 'txt' | 'json';

export interface ReadDocumentInput {
  source: string;
  format?: DocumentFormat;
  filename?: string;
  query?: string;
  page_range?: string;
  max_chars?: number;
}

export interface DocumentPageSection {
  pageNumber: number;
  title?: string;
  text: string;
}

export interface DocumentMetadata {
  format: Exclude<DocumentFormat, 'auto'>;
  filename?: string;
  title?: string;
  author?: string;
  pageCount: number;
  charCount: number;
  truncated: boolean;
  columns?: string[];
  rowCount?: number;
}

export interface ReadDocumentResult {
  metadata: DocumentMetadata;
  pages: DocumentPageSection[];
  content: string;
  fullContent: string;
}

export interface PdfBinaryExtractor {
  extractPdf(
    bytes: Uint8Array,
    options?: { filename?: string },
  ): Promise<{
    title?: string;
    author?: string;
    pages: DocumentPageSection[];
  }>;
}

export type WebSearchEngine = 'ddg' | 'bing' | 'startpage';

export interface SearchResultItem {
  title: string;
  url: string;
  snippet: string;
  domain: string;
}

export interface ChromiumSerpResponse {
  ok: boolean;
  engine: WebSearchEngine;
  query: string;
  results: SearchResultItem[];
  elapsedMs: number;
  blockedByCaptcha?: boolean;
  manualUrl?: string;
  error?: string;
}

export interface WebSearchResult {
  ok: boolean;
  query: string;
  results: SearchResultItem[];
  fromHiddenTab?: boolean;
  engine?: WebSearchEngine | (string & {});
  elapsedMs?: number;
  scrapedSources?: FetchedSourceResult[];
  needsPermission?: boolean;
  blockedByCaptcha?: boolean;
  manualUrl?: string;
  error?: string;
}

export interface FetchedSourceResult {
  url: string;
  title: string;
  markdown: string;
  excerpt: string;
  snippet?: string;
  charCount: number;
  fromHiddenTab: boolean;
  error?: string;
  blockedByCaptcha?: boolean;
  manualUrl?: string;
}

export interface HiddenTabHtmlResponse {
  html: string;
  title?: string;
  url?: string;
  markdown?: string;
  blockedByCaptcha?: boolean;
}

export type MemoryTier = 'working' | 'profile' | 'episodic' | 'document';

export interface MemoryRecordInput {
  tier: MemoryTier;
  content: string;
  sourceUrl?: string;
  sourceTitle?: string;
  threadId?: string;
  tags?: string[];
  importance?: number;
  tainted?: boolean;
  supersedesId?: string;
}

export interface MemoryRecord extends MemoryRecordInput {
  id: string;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  accessCount: number;
  supersededById?: string;
}

export interface MemoryQuery {
  query: string;
  tiers?: MemoryTier[];
  limit?: number;
  minScore?: number;
  nowMs?: number;
}

export interface MemoryHit {
  record: MemoryRecord;
  score: number;
  bm25Rank?: number;
  vectorRank?: number;
  recencyWeight: number;
}

export interface MemoryProvider {
  remember(input: MemoryRecordInput): Promise<MemoryRecord>;
  recall(query: MemoryQuery): Promise<MemoryHit[]>;
  inspect?(filter?: { tier?: MemoryTier; limit?: number; offset?: number }): Promise<MemoryRecord[]>;
  forget?(id: string): Promise<boolean>;
}
