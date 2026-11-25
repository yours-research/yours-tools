import { describe, expect, it } from 'vitest';
import {
  CANONICAL_TOOL_DEFINITIONS,
  LEGACY_TOOL_ALIASES,
  formatToolsForSystemPrompt,
  getToolDefinition,
  resolveToolAlias,
  toOpenAIToolSchemas,
  toPragmaToolBundle,
  toQwenToolSchemas,
  validateCanonicalToolCall,
} from '../src/schemas/index.js';

describe('Canonical Schema Registry v1.1 & Alias Resolver', () => {
  it('registers all 10 canonical tools with valid ToolSafetyHints', () => {
    expect(CANONICAL_TOOL_DEFINITIONS).toHaveLength(10);
    const names = CANONICAL_TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toEqual([
      'read_active_tab',
      'list_tabs',
      'read_tab',
      'interact_page',
      'run_sandbox',
      'read_document',
      'search_web_tab',
      'fetch_background_tab',
      'memory_recall',
      'memory_save',
    ]);

    for (const def of CANONICAL_TOOL_DEFINITIONS) {
      expect(typeof def.safety.readOnlyHint).toBe('boolean');
      expect(typeof def.safety.consequentialHint).toBe('boolean');
      expect(typeof def.safety.networkHint).toBe('boolean');
      expect(typeof def.safety.untrustedContentHint).toBe('boolean');
      expect(def.parameters.additionalProperties).toBe(false);
    }

    // Network tools must declare networkHint: true
    expect(getToolDefinition('search_web_tab').safety.networkHint).toBe(true);
    expect(getToolDefinition('fetch_background_tab').safety.networkHint).toBe(true);

    // Local compute & memory tools must declare networkHint: false
    expect(getToolDefinition('run_sandbox').safety.networkHint).toBe(false);
    expect(getToolDefinition('read_document').safety.networkHint).toBe(false);

    // State-mutating tools must declare readOnlyHint: false & consequentialHint: true
    expect(getToolDefinition('interact_page').safety).toMatchObject({
      readOnlyHint: false,
      consequentialHint: true,
    });
    expect(getToolDefinition('memory_save').safety).toMatchObject({
      readOnlyHint: false,
      consequentialHint: true,
    });
  });

  it('resolves all legacy aliases cleanly and normalizes legacy camelCase params', () => {
    expect(Object.keys(LEGACY_TOOL_ALIASES)).toHaveLength(5);
    expect(resolveToolAlias('read_active_page')).toBe('read_active_tab');
    expect(resolveToolAlias('list_open_tabs')).toBe('list_tabs');
    expect(resolveToolAlias('web_search')).toBe('search_web_tab');
    expect(resolveToolAlias('fetch_and_read_url')).toBe('fetch_background_tab');
    expect(resolveToolAlias('js_calc')).toBe('run_sandbox');
    expect(resolveToolAlias('unknown_tool')).toBeNull();

    const readActive = validateCanonicalToolCall({
      name: 'read_active_page',
      arguments: { maxChars: 12000, includeLinks: true, mode: 'aom' },
    });
    expect(readActive.valid).toBe(true);
    expect(readActive.normalized?.name).toBe('read_active_tab');
    expect(readActive.normalized?.originalName).toBe('read_active_page');
    expect(readActive.normalized?.arguments).toMatchObject({
      max_chars: 12000,
      include_links: true,
      mode: 'aom',
    });

    const readTab = validateCanonicalToolCall({
      name: 'read_tab',
      arguments: { tabId: 42, maxChars: 5000 },
    });
    expect(readTab.valid).toBe(true);
    expect(readTab.normalized?.arguments).toMatchObject({ tab_id: 42, max_chars: 5000 });

    const webSearch = validateCanonicalToolCall({
      name: 'web_search',
      arguments: { query: 'local webgpu inference', limit: 3, readTopN: 1 },
    });
    expect(webSearch.valid).toBe(true);
    expect(webSearch.normalized?.name).toBe('search_web_tab');
    expect(webSearch.normalized?.arguments).toMatchObject({
      query: 'local webgpu inference',
      max_results: 3,
      read_top_n: 1,
    });

    const fetchLegacy = validateCanonicalToolCall({
      name: 'fetch_and_read_url',
      arguments: { urls: ['https://yours.sh'], maxCharsPerSource: 3200 },
    });
    expect(fetchLegacy.valid).toBe(true);
    expect(fetchLegacy.normalized?.name).toBe('fetch_background_tab');
    expect(fetchLegacy.normalized?.arguments).toMatchObject({
      url: 'https://yours.sh',
      urls: ['https://yours.sh'],
      max_chars: 3200,
    });
  });

  it('rejects invalid tool calls with clear validation errors', () => {
    expect(validateCanonicalToolCall({ name: 'nope', arguments: {} }).valid).toBe(false);
    expect(validateCanonicalToolCall({ name: 'read_tab', arguments: { tab_id: 0 } }).valid).toBe(false);
    expect(validateCanonicalToolCall({ name: 'interact_page', arguments: { action: 'click' } }).valid).toBe(false);
    expect(validateCanonicalToolCall({ name: 'fetch_background_tab', arguments: { url: 'ftp://bad' } }).valid).toBe(false);
  });

  it('exports OpenAI, Qwen, Pragma, and prompt formats cleanly', () => {
    const openai = toOpenAIToolSchemas();
    expect(openai).toHaveLength(10);
    expect(openai[0].type).toBe('function');

    const qwen = toQwenToolSchemas();
    expect(qwen[0].safety).toBeDefined();

    const pragma = toPragmaToolBundle();
    expect(pragma.family).toBe('yours-pragma-1');
    expect(pragma.version).toBe('1.1.0');
    expect(pragma.tools).toHaveLength(10);

    const promptXml = formatToolsForSystemPrompt(undefined, 'qwen-xml');
    expect(promptXml.startsWith('<tools>')).toBe(true);
    expect(promptXml.includes('"interact_page"')).toBe(true);
  });
});
