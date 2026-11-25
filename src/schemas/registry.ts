import type { CanonicalToolName, ToolDefinition } from '../types.js';

/**
 * Canonical Tool Schema v1.1 Registry (`@yours/tools` <-> `yours-research-lab` Pragma Training).
 */
export const CANONICAL_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    name: 'read_active_tab',
    aliases: ['read_active_page'],
    description:
      'Read the clean extracted text, semantic AOM snapshot, title, URL, and optional structural metadata of the currently active browser tab, or query within the page using BM25.',
    parameters: {
      type: 'object',
      properties: {
        include_links: {
          type: 'boolean',
          default: false,
          description: 'Whether to include extracted hyperlinks alongside page text.',
        },
        max_chars: {
          type: 'integer',
          minimum: 500,
          maximum: 120000,
          default: 24000,
          description: 'Maximum character budget to return from the active tab.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'article', 'selection', 'interactive', 'aom'],
          default: 'auto',
          description: 'Extraction mode (default auto; use aom for compact accessibility tree + node IDs).',
        },
        query: {
          type: 'string',
          description: 'Optional focus query to retrieve matching passages from the full page using BM25.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: true,
      consequentialHint: false,
      networkHint: false,
      untrustedContentHint: true,
    },
  },
  {
    name: 'list_tabs',
    aliases: ['list_open_tabs'],
    description:
      'List open tabs in the browser window (tab ID, title, URL, and active status) to identify relevant tabs before reading or interacting with one.',
    parameters: {
      type: 'object',
      properties: {
        window_scope: {
          type: 'string',
          enum: ['current', 'all'],
          default: 'current',
          description: 'List tabs from the current window only or across all open browser windows.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: true,
      consequentialHint: false,
      networkHint: false,
      untrustedContentHint: true,
    },
  },
  {
    name: 'read_tab',
    aliases: [],
    description:
      'Read the clean extracted text, semantic AOM snapshot, title, and URL of a specific open browser tab identified by tab_id from list_tabs.',
    parameters: {
      type: 'object',
      properties: {
        tab_id: {
          type: 'integer',
          minimum: 1,
          description: 'Numeric browser tab identifier returned by list_tabs.',
        },
        max_chars: {
          type: 'integer',
          minimum: 500,
          maximum: 120000,
          default: 24000,
          description: 'Maximum character budget to return from the tab.',
        },
        mode: {
          type: 'string',
          enum: ['auto', 'article', 'selection', 'interactive', 'aom'],
          default: 'auto',
          description: 'Extraction mode (default auto).',
        },
        query: {
          type: 'string',
          description: 'Optional focus query to retrieve matching passages using BM25.',
        },
        include_links: {
          type: 'boolean',
          default: false,
          description: 'Whether to include extracted hyperlinks alongside page text.',
        },
      },
      required: ['tab_id'],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: true,
      consequentialHint: false,
      networkHint: false,
      untrustedContentHint: true,
    },
  },
  {
    name: 'interact_page',
    aliases: [],
    description:
      'Execute a bounded DOM interaction (click, type, select, check, scroll, focus, hover) on an element identified by its semantic node_id from an AOM snapshot, returning a settled DOM diff.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['click', 'type', 'select', 'check', 'scroll', 'focus', 'hover'],
          description: 'Bounded interaction action to execute.',
        },
        node_id: {
          type: 'integer',
          minimum: 1,
          description: 'Semantic node ID assigned by AOM/interactive extraction.',
        },
        text: {
          type: 'string',
          description: 'Text to enter when action is "type".',
        },
        value: {
          type: 'string',
          description: 'Option value or label when action is "select".',
        },
        checked: {
          type: 'boolean',
          description: 'Explicit target checked state when action is "check".',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down', 'top', 'bottom'],
          default: 'down',
          description: 'Scroll direction when action is "scroll".',
        },
        amount: {
          type: 'integer',
          minimum: 50,
          maximum: 5000,
          default: 500,
          description: 'Scroll distance in CSS pixels.',
        },
        tab_id: {
          type: 'integer',
          minimum: 1,
          description: 'Optional target tab ID (defaults to active tab).',
        },
        submit: {
          type: 'boolean',
          default: false,
          description: 'Submit the enclosing form after typing (only when explicitly intended).',
        },
        clear: {
          type: 'boolean',
          default: true,
          description: 'Clear existing text before typing.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: false,
      consequentialHint: true,
      networkHint: false,
      untrustedContentHint: true,
    },
  },
  {
    name: 'run_sandbox',
    aliases: ['js_calc'],
    description:
      'Air-gapped deterministic compute and data transform sandbox supporting math expressions, unit conversions, date arithmetic, JSON path queries, CSV stats, pipeline transforms, and QuickJS-isolated JS evaluation with zero network/DOM/chrome access.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['expr', 'unit', 'date', 'json', 'csv', 'transform', 'js'],
          default: 'expr',
          description: 'Execution mode (default expr).',
        },
        expression: {
          type: 'string',
          description: 'Math expression or transform expression.',
        },
        code: {
          type: 'string',
          description: 'Sandboxed JavaScript snippet for mode "js" or transform pipeline for "transform".',
        },
        value: {
          description: 'Input value for unit/date/json modes.',
        },
        from: {
          type: 'string',
          description: 'Source unit for unit mode.',
        },
        to: {
          type: 'string',
          description: 'Target unit for unit mode.',
        },
        dateA: {
          type: 'string',
          description: 'First ISO-8601 date string.',
        },
        dateB: {
          type: 'string',
          description: 'Second ISO-8601 date string.',
        },
        days: {
          type: 'number',
          description: 'Day offset for date arithmetic.',
        },
        data: {
          description: 'Raw JSON, CSV string, or structured input data.',
        },
        path: {
          type: 'string',
          description: 'JSON path such as a.b[0].c.',
        },
        timeout_ms: {
          type: 'integer',
          minimum: 10,
          maximum: 5000,
          default: 1000,
          description: 'Execution timeout ceiling in milliseconds.',
        },
        memory_limit_bytes: {
          type: 'integer',
          minimum: 65536,
          maximum: 33554432,
          default: 8388608,
          description: 'Memory ceiling in bytes for sandbox execution.',
        },
      },
      required: [],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: true,
      consequentialHint: false,
      networkHint: false,
      untrustedContentHint: false,
    },
  },
  {
    name: 'read_document',
    aliases: [],
    description:
      'Extract structured text and page metadata from a local PDF, Markdown, HTML, CSV, JSON, or plain-text document offline inside an Offscreen Document or Worker.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          minLength: 1,
          description: 'Document content, base64/data URL, or registered virtual document identifier.',
        },
        format: {
          type: 'string',
          enum: ['auto', 'pdf', 'markdown', 'html', 'csv', 'txt', 'json'],
          default: 'auto',
          description: 'Explicit document format or auto-detect.',
        },
        filename: {
          type: 'string',
          description: 'Optional filename hint for format detection and metadata.',
        },
        query: {
          type: 'string',
          description: 'Optional BM25 query to extract relevant passages from the document.',
        },
        page_range: {
          type: 'string',
          description: 'Optional 1-indexed page range such as "1-3" or "2".',
        },
        max_chars: {
          type: 'integer',
          minimum: 500,
          maximum: 120000,
          default: 24000,
          description: 'Maximum character budget to return.',
        },
      },
      required: ['source'],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: true,
      consequentialHint: false,
      networkHint: false,
      untrustedContentHint: true,
    },
  },
  {
    name: 'search_web_tab',
    aliases: ['web_search'],
    description:
      'Run a web search query inside a hidden background browser tab and return top result titles, URLs, snippets, and optional source excerpts.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'Search query string.',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          default: 5,
          description: 'Maximum number of search results to return.',
        },
        read_top_n: {
          type: 'integer',
          minimum: 0,
          maximum: 3,
          default: 2,
          description: 'Number of top unique-domain results to auto-read into markdown excerpts.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: true,
      consequentialHint: false,
      networkHint: true,
      untrustedContentHint: true,
    },
  },
  {
    name: 'fetch_background_tab',
    aliases: ['fetch_and_read_url'],
    description:
      'Open a URL (or up to 5 URLs) in a hidden background browser tab, wait for primary content to settle, extract clean markdown text, and close the hidden tab.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          pattern: '^https?://',
          description: 'HTTP or HTTPS URL to load and read in a background tab.',
        },
        urls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of 1-5 HTTP/HTTPS URLs to fetch in parallel (legacy compatibility).',
        },
        query: {
          type: 'string',
          description: 'Optional focus query for BM25 passage ranking.',
        },
        max_chars: {
          type: 'integer',
          minimum: 500,
          maximum: 120000,
          default: 24000,
          description: 'Maximum character budget to extract from the fetched page(s).',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: true,
      consequentialHint: false,
      networkHint: true,
      untrustedContentHint: true,
    },
  },
  {
    name: 'memory_recall',
    aliases: [],
    description:
      'Search local persistent agent memory across working, profile, episodic, and document tiers using BM25 + recency ranking.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          description: 'Recall query string.',
        },
        tiers: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['working', 'profile', 'episodic', 'document'],
          },
          description: 'Optional memory tiers to filter.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          default: 5,
          description: 'Maximum memory hits to return.',
        },
        min_score: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0,
          description: 'Minimum relevance score threshold [0..1].',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: true,
      consequentialHint: false,
      networkHint: false,
      untrustedContentHint: false,
    },
  },
  {
    name: 'memory_save',
    aliases: [],
    description:
      'Persist a structured fact, user preference, or episodic summary to local encrypted browser memory.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          minLength: 1,
          description: 'Concise factual note or preference to remember.',
        },
        tier: {
          type: 'string',
          enum: ['working', 'profile', 'episodic', 'document'],
          default: 'episodic',
          description: 'Target memory tier.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional categorization tags.',
        },
        importance: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          default: 0.7,
          description: 'Importance weight [0..1].',
        },
        source_url: {
          type: 'string',
          description: 'Optional provenance URL.',
        },
        source_title: {
          type: 'string',
          description: 'Optional provenance page title.',
        },
      },
      required: ['content'],
      additionalProperties: false,
    },
    safety: {
      readOnlyHint: false,
      consequentialHint: true,
      networkHint: false,
      untrustedContentHint: false,
    },
  },
] as const;

export const CANONICAL_TOOL_MAP: ReadonlyMap<CanonicalToolName, ToolDefinition> = new Map(
  CANONICAL_TOOL_DEFINITIONS.map((def) => [def.name, def]),
);

export function getToolDefinition(name: CanonicalToolName): ToolDefinition {
  const def = CANONICAL_TOOL_MAP.get(name);
  if (!def) {
    throw new Error(`Unknown canonical tool "${name}".`);
  }
  return def;
}

export function listCanonicalTools(): ToolDefinition[] {
  return [...CANONICAL_TOOL_DEFINITIONS];
}
