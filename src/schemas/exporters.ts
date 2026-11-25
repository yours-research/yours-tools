import type { ToolDefinition } from '../types.js';
import { CANONICAL_TOOL_DEFINITIONS } from './registry.js';

export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition['parameters'];
  };
}

export interface PragmaToolBundle {
  $schema: string;
  version: string;
  family: string;
  tools: OpenAIFunctionTool[];
}

export interface QwenToolExport {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: ToolDefinition['parameters'];
  };
  safety: ToolDefinition['safety'];
}

/**
 * Exports ToolDefinitions in OpenAI function-calling JSON-Schema format.
 */
export function toOpenAIToolSchemas(
  tools: readonly ToolDefinition[] = CANONICAL_TOOL_DEFINITIONS,
): OpenAIFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Exports ToolDefinitions in Qwen / Hermes function-calling format with safety metadata.
 */
export function toQwenToolSchemas(
  tools: readonly ToolDefinition[] = CANONICAL_TOOL_DEFINITIONS,
): QwenToolExport[] {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
    safety: tool.safety,
  }));
}

/**
 * Exports a Pragma fine-tuning schema bundle compatible with `yours-research-lab/lab/TOOLS_SCHEMA.json`.
 */
export function toPragmaToolBundle(
  tools: readonly ToolDefinition[] = CANONICAL_TOOL_DEFINITIONS,
  options?: { version?: string; family?: string },
): PragmaToolBundle {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    version: options?.version ?? '1.1.0',
    family: options?.family ?? 'yours-pragma-1',
    tools: toOpenAIToolSchemas(tools),
  };
}

/**
 * Formats tool definitions into a compact system prompt block for local models.
 */
export function formatToolsForSystemPrompt(
  tools: readonly ToolDefinition[] = CANONICAL_TOOL_DEFINITIONS,
  format: 'qwen-xml' | 'json' = 'qwen-xml',
): string {
  const openAiTools = toOpenAIToolSchemas(tools);
  if (format === 'json') {
    return JSON.stringify(openAiTools, null, 2);
  }
  const lines = openAiTools.map((t) => JSON.stringify(t));
  return `<tools>\n${lines.join('\n')}\n</tools>`;
}
