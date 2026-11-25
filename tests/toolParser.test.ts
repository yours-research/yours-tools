import { describe, expect, it } from 'vitest';
import {
  ToolCallJsonGrammar,
  detectPendingToolCall,
  formatToolResultMessage,
  parseOpenAIToolCalls,
  parseToolCalls,
} from '../src/protocol/toolParser.js';

describe('Resilient Tool-Call Parser & Streaming Grammar', () => {
  it('parses standard <tool_call> JSON, Qwen XML, bare XML, and OpenAI formats', () => {
    const qwenXml = `Let me check.\n<tool_call>\n<function=interact_page>\n<parameter=action>click</parameter>\n<parameter=node_id>3</parameter>\n</function>\n</tool_call>`;
    const res1 = parseToolCalls(qwenXml);
    expect(res1.parseErrors).toEqual([]);
    expect(res1.cleanText).toBe('Let me check.');
    expect(res1.toolCalls[0]).toMatchObject({
      name: 'interact_page',
      arguments: { action: 'click', node_id: 3 },
    });

    const openaiRes = parseOpenAIToolCalls([
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'read_active_page',
          arguments: '{"maxChars": 4000, "mode": "aom"}',
        },
      },
    ]);
    expect(openaiRes.parseErrors).toEqual([]);
    expect(openaiRes.toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'read_active_tab',
      originalName: 'read_active_page',
      arguments: { max_chars: 4000, mode: 'aom' },
    });
  });

  it('repairs malformed partial JSON (trailing commas, unescaped newlines, truncated braces)', () => {
    const malformed = `Checking...\n<tool_call>{"name": "run_sandbox", "arguments": {"mode": "js", "code": "const a = 1;\nreturn a + 2;",},</tool_call>`;
    const res1 = parseToolCalls(malformed);
    expect(res1.parseErrors).toEqual([]);
    expect(res1.toolCalls[0].name).toBe('run_sandbox');
    expect(res1.toolCalls[0].arguments.code).toContain('return a + 2;');

    const truncated = `<tool_call>{"name": "search_web_tab", "arguments": {"query": "webgpu", "max_results": 3`;
    const res2 = parseToolCalls(truncated);
    expect(res2.parseErrors).toEqual([]);
    expect(res2.toolCalls[0]).toMatchObject({
      name: 'search_web_tab',
      arguments: { query: 'webgpu', max_results: 3 },
    });
  });

  it('detects pending streaming tool calls, formats tainted results, and validates JSON prefix grammar', () => {
    const pending = detectPendingToolCall('Thinking...\n<tool_call>{"name": "read_active_page", "arg');
    expect(pending).toEqual({
      isOpen: true,
      toolName: 'read_active_tab',
      rawToolName: 'read_active_page',
      label: 'Reading active tab...',
    });

    const msg = formatToolResultMessage('read_active_tab', {
      ok: true,
      toolName: 'read_active_tab',
      formatted: 'Hello world',
      tainted: true,
    });
    expect(msg).toContain('tainted="true"');

    expect(ToolCallJsonGrammar.isValidToolJsonPrefix('{"name": "read_tab", "arguments": {"tab_id": 1')).toBe(true);
    expect(ToolCallJsonGrammar.isValidToolJsonPrefix('{"name": bad}')).toBe(false);
  });
});
