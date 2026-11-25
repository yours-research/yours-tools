import {
  TOOL_UI_LABELS,
  resolveToolAlias,
  validateCanonicalToolCall,
} from '../schemas/aliases.js';
import type {
  ParsedToolCall,
  PendingToolDetection,
  ToolExecutionResult,
} from '../types.js';

function escapeUnescapedNewlinesInStrings(jsonText: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
      } else if (ch === '\\') {
        out += ch;
        escaped = true;
      } else if (ch === '"') {
        out += ch;
        inString = false;
      } else if (ch === '\n') {
        out += '\\n';
      } else if (ch === '\r') {
        out += '\\r';
      } else if (ch === '\t') {
        out += '\\t';
      } else {
        out += ch;
      }
      continue;
    }

    if (ch === '"') inString = true;
    out += ch;
  }

  return out;
}

function stripTrailingCommas(jsonText: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < jsonText.length && /\s/.test(jsonText[j])) j++;
      if (jsonText[j] === '}' || jsonText[j] === ']') continue;
    }
    out += ch;
  }

  return out;
}

function balanceTruncatedJson(jsonText: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if ((ch === '}' || ch === ']') && stack.length > 0 && stack[stack.length - 1] === ch) {
      stack.pop();
    }
  }

  let out = jsonText;
  if (inString) out += '"';
  while (stack.length > 0) {
    out += stack.pop();
  }
  out = stripTrailingCommas(out);
  return out;
}

function convertSingleQuotedJsonLike(text: string): string {
  // Replace single-quoted keys/strings only when standard JSON parse failed
  return text.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_m, inner: string) => {
    const escaped = inner.replace(/"/g, '\\"');
    return `"${escaped}"`;
  });
}

function parseXmlFunctionCall(rawBody: string): { name?: unknown; arguments?: Record<string, unknown> } | null {
  const fnMatch = /<function=([^>\s]+)>([\s\S]*?)<\/function>/i.exec(rawBody);
  if (!fnMatch) return null;
  const name = fnMatch[1].trim();
  const body = fnMatch[2];
  const args: Record<string, unknown> = {};
  const paramRegex = /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = paramRegex.exec(body)) !== null) {
    const key = pm[1].trim();
    const rawVal = pm[2].trim();
    if (
      (rawVal.startsWith('[') && rawVal.endsWith(']')) ||
      (rawVal.startsWith('{') && rawVal.endsWith('}')) ||
      rawVal === 'true' ||
      rawVal === 'false' ||
      /^-?\d+(?:\.\d+)?$/.test(rawVal)
    ) {
      try {
        args[key] = JSON.parse(rawVal);
        continue;
      } catch {
        // Keep string fallback
      }
    }
    args[key] = rawVal;
  }
  return { name, arguments: args };
}

function repairAndParsePayload(rawBlock: string): unknown {
  let candidate = rawBlock.trim();

  const fenceMatch = /^```(?:json|xml)?\s*([\s\S]*?)\s*```$/i.exec(candidate);
  if (fenceMatch) {
    candidate = fenceMatch[1].trim();
  }

  const xmlCall = parseXmlFunctionCall(candidate);
  if (xmlCall) {
    return xmlCall;
  }

  // Try direct JSON parse first
  try {
    return JSON.parse(candidate);
  } catch {
    // Progressive repair pipeline
    const attempts = [
      () => JSON.parse(stripTrailingCommas(escapeUnescapedNewlinesInStrings(candidate))),
      () => JSON.parse(balanceTruncatedJson(escapeUnescapedNewlinesInStrings(candidate))),
      () =>
        JSON.parse(
          balanceTruncatedJson(
            convertSingleQuotedJsonLike(escapeUnescapedNewlinesInStrings(candidate)),
          ),
        ),
    ];

    let lastErr: unknown;
    for (const attempt of attempts) {
      try {
        return attempt();
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('Malformed tool call payload.');
  }
}

function normalizeParsedEntry(
  rawObj: unknown,
  rawText: string,
  parseErrors: string[],
): ParsedToolCall | null {
  if (!rawObj || typeof rawObj !== 'object' || Array.isArray(rawObj)) {
    parseErrors.push('Tool call payload must be a JSON object.');
    return null;
  }

  const rec = rawObj as Record<string, unknown>;
  // Handle OpenAI-style { id, type: 'function', function: { name, arguments } }
  const fnObj =
    rec.function && typeof rec.function === 'object' && !Array.isArray(rec.function)
      ? (rec.function as Record<string, unknown>)
      : rec;

  const rawName = typeof fnObj.name === 'string' ? fnObj.name : '';
  let rawArgs: unknown = fnObj.arguments ?? fnObj.args ?? fnObj.parameters ?? {};

  if (typeof rawArgs === 'string') {
    const trimmedArgs = rawArgs.trim();
    if (!trimmedArgs) {
      rawArgs = {};
    } else {
      try {
        rawArgs = repairAndParsePayload(trimmedArgs);
      } catch (err: unknown) {
        parseErrors.push(
          `Malformed stringified arguments for "${rawName}": ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      }
    }
  }

  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    parseErrors.push(`Tool call arguments for "${rawName}" must be an object.`);
    return null;
  }

  const validation = validateCanonicalToolCall({
    id: typeof rec.id === 'string' ? rec.id : undefined,
    name: rawName,
    arguments: rawArgs as Record<string, unknown>,
  });

  if (!validation.valid || !validation.normalized) {
    parseErrors.push(validation.error ?? 'Invalid tool call.');
    return null;
  }

  return {
    ...validation.normalized,
    raw: rawText,
  };
}

/**
 * Resilient parser for `<tool_call>` JSON, Qwen `<function=...>`, bare `<function=...>` blocks,
 * fenced JSON tool calls, and malformed/partial JSON tool arguments, with automatic legacy alias resolution.
 */
export function parseToolCalls(text: string): {
  cleanText: string;
  toolCalls: ParsedToolCall[];
  parseErrors: string[];
} {
  const toolCalls: ParsedToolCall[] = [];
  const parseErrors: string[] = [];

  if (!text) {
    return { cleanText: '', toolCalls, parseErrors };
  }

  // Match <tool_call>...</tool_call>, unclosed trailing <tool_call>..., bare <function=...>...</function>, or ```json {"name":...}```
  const combinedRegex =
    /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)|(<function=[^>\s]+>[\s\S]*?<\/function>)|```(?:json)?\s*(\{\s*"name"\s*:[\s\S]*?\})\s*```/gi;

  const cleanParts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = combinedRegex.exec(text)) !== null) {
    cleanParts.push(text.slice(lastIndex, match.index));
    lastIndex = match.index + match[0].length;

    const rawBody = match[1] ?? match[2] ?? match[3] ?? '';
    try {
      const parsed = repairAndParsePayload(rawBody);
      const normalized = normalizeParsedEntry(parsed, match[0], parseErrors);
      if (normalized) {
        toolCalls.push(normalized);
      }
    } catch (err: unknown) {
      parseErrors.push(err instanceof Error ? err.message : 'Failed to parse tool call.');
    }
  }

  cleanParts.push(text.slice(lastIndex));
  const cleanText = cleanParts.join('').replace(/\n{3,}/g, '\n\n').trim();

  return { cleanText, toolCalls, parseErrors };
}

/**
 * Parses OpenAI-format `tool_calls` arrays directly into validated canonical `ParsedToolCall`s.
 */
export function parseOpenAIToolCalls(
  rawCalls: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: unknown } }>,
): { toolCalls: ParsedToolCall[]; parseErrors: string[] } {
  const toolCalls: ParsedToolCall[] = [];
  const parseErrors: string[] = [];
  for (const call of rawCalls) {
    const normalized = normalizeParsedEntry(call, JSON.stringify(call), parseErrors);
    if (normalized) {
      toolCalls.push(normalized);
    }
  }
  return { toolCalls, parseErrors };
}

export function detectPendingToolCall(streamedText: string): PendingToolDetection | null {
  if (!streamedText) return null;
  const lower = streamedText.toLowerCase();
  const lastOpen = lower.lastIndexOf('<tool_call>');
  if (lastOpen === -1) return null;
  const lastClose = lower.lastIndexOf('</tool_call>');
  if (lastClose > lastOpen) return null;

  const partial = streamedText.slice(lastOpen + '<tool_call>'.length);
  const nameMatch =
    /"name"\s*:\s*"([a-zA-Z0-9_]+)"/.exec(partial) ?? /<function=([a-zA-Z0-9_]+)>/.exec(partial);
  const rawToolName = nameMatch ? nameMatch[1] : null;
  const canonical = rawToolName ? resolveToolAlias(rawToolName) : null;
  const label = canonical ? TOOL_UI_LABELS[canonical] : 'Running tool...';

  return {
    isOpen: true,
    toolName: canonical,
    rawToolName,
    label,
  };
}

export function formatToolResultMessage(toolName: string, result: ToolExecutionResult): string {
  const payload = result.formatted
    ? result.formatted
    : JSON.stringify(
        result.ok
          ? result.data ?? {}
          : {
              error: result.error ?? 'Tool execution failed.',
              ...(result.needsPermission ? { needsPermission: true } : {}),
              ...(result.requiresApproval ? { requiresApproval: true } : {}),
              ...(result.blockedByCaptcha ? { blockedByCaptcha: true, manualUrl: result.manualUrl } : {}),
            },
      );
  const taintAttr = result.tainted ? ' tainted="true"' : '';
  return `<tool_result name="${toolName}" ok="${result.ok ? 'true' : 'false'}"${taintAttr}>\n${payload}\n</tool_result>`;
}

type GrammarFrame =
  | 'object_start_or_key'
  | 'object_colon'
  | 'object_value'
  | 'object_comma_or_end'
  | 'array_start_or_val'
  | 'array_comma_or_end';

function analyzeJsonPrefix(partial: string): { valid: boolean; hint: string } {
  const trimmedStart = partial.trimStart();
  if (!trimmedStart) return { valid: true, hint: '{' };
  if (trimmedStart[0] !== '{') return { valid: false, hint: '{' };

  const stack: GrammarFrame[] = [];
  let i = 0;
  let rootClosed = false;

  while (i < trimmedStart.length) {
    while (i < trimmedStart.length && /\s/.test(trimmedStart[i])) i++;
    if (i >= trimmedStart.length) break;

    const ch = trimmedStart[i];
    const top = stack[stack.length - 1];

    if (stack.length === 0) {
      if (!rootClosed && ch === '{') {
        stack.push('object_start_or_key');
        i++;
        continue;
      }
      return { valid: false, hint: 'EOF' };
    }

    if (top === 'object_start_or_key') {
      if (ch === '}') {
        stack.pop();
        i++;
        if (stack.length === 0) rootClosed = true;
        else {
          const parent = stack[stack.length - 1];
          if (parent === 'object_value') stack[stack.length - 1] = 'object_comma_or_end';
          else if (parent === 'array_start_or_val') stack[stack.length - 1] = 'array_comma_or_end';
        }
        continue;
      }
      if (ch === '"') {
        i++;
        let closed = false;
        while (i < trimmedStart.length) {
          if (trimmedStart[i] === '\\') { i += 2; continue; }
          if (trimmedStart[i] === '"') { closed = true; i++; break; }
          i++;
        }
        if (!closed) return { valid: true, hint: 'key_string_char_or_"' };
        stack[stack.length - 1] = 'object_colon';
        continue;
      }
      return { valid: false, hint: '"key" or }' };
    }

    if (top === 'object_colon') {
      if (ch === ':') { stack[stack.length - 1] = 'object_value'; i++; continue; }
      return { valid: false, hint: ':' };
    }

    if (top === 'object_comma_or_end') {
      if (ch === ',') { stack[stack.length - 1] = 'object_start_or_key'; i++; continue; }
      if (ch === '}') {
        stack.pop();
        i++;
        if (stack.length === 0) rootClosed = true;
        else {
          const parent = stack[stack.length - 1];
          if (parent === 'object_value') stack[stack.length - 1] = 'object_comma_or_end';
          else if (parent === 'array_start_or_val') stack[stack.length - 1] = 'array_comma_or_end';
        }
        continue;
      }
      return { valid: false, hint: ', or }' };
    }

    if (top === 'array_comma_or_end') {
      if (ch === ',') { stack[stack.length - 1] = 'array_start_or_val'; i++; continue; }
      if (ch === ']') {
        stack.pop();
        i++;
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          if (parent === 'object_value') stack[stack.length - 1] = 'object_comma_or_end';
          else if (parent === 'array_start_or_val') stack[stack.length - 1] = 'array_comma_or_end';
        }
        continue;
      }
      return { valid: false, hint: ', or ]' };
    }

    if (top === 'object_value' || top === 'array_start_or_val') {
      if (top === 'array_start_or_val' && ch === ']') {
        stack.pop();
        i++;
        if (stack.length > 0) {
          const parent = stack[stack.length - 1];
          if (parent === 'object_value') stack[stack.length - 1] = 'object_comma_or_end';
          else if (parent === 'array_start_or_val') stack[stack.length - 1] = 'array_comma_or_end';
        }
        continue;
      }

      const advanceValueDone = () => {
        if (top === 'object_value') stack[stack.length - 1] = 'object_comma_or_end';
        else stack[stack.length - 1] = 'array_comma_or_end';
      };

      if (ch === '{') { stack.push('object_start_or_key'); i++; continue; }
      if (ch === '[') { stack.push('array_start_or_val'); i++; continue; }
      if (ch === '"') {
        i++;
        let closed = false;
        while (i < trimmedStart.length) {
          if (trimmedStart[i] === '\\') { i += 2; continue; }
          if (trimmedStart[i] === '"') { closed = true; i++; break; }
          i++;
        }
        if (!closed) return { valid: true, hint: 'string_char_or_"' };
        advanceValueDone();
        continue;
      }
      if (ch === '-' || (ch >= '0' && ch <= '9')) {
        const numMatch = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(trimmedStart.slice(i));
        const partialNumMatch = /^-?(?:\d+\.?|\d*\.\d+(?:[eE][+-]?)?)?/.exec(trimmedStart.slice(i));
        if (i + (numMatch?.[0].length ?? 0) === trimmedStart.length && partialNumMatch) {
          return { valid: true, hint: 'number_digit_or_delimiter' };
        }
        if (!numMatch) return { valid: false, hint: 'number' };
        i += numMatch[0].length;
        advanceValueDone();
        continue;
      }
      if (ch === 't' || ch === 'f' || ch === 'n') {
        const kw = ch === 't' ? 'true' : ch === 'f' ? 'false' : 'null';
        const rem = trimmedStart.slice(i);
        if (kw.startsWith(rem)) return { valid: true, hint: kw };
        if (rem.startsWith(kw)) { i += kw.length; advanceValueDone(); continue; }
        return { valid: false, hint: kw };
      }
      return { valid: false, hint: 'json_value' };
    }
  }

  if (stack.length === 0) return { valid: true, hint: 'EOF' };
  const top = stack[stack.length - 1];
  switch (top) {
    case 'object_start_or_key': return { valid: true, hint: '"key" or }' };
    case 'object_colon': return { valid: true, hint: ':' };
    case 'object_value': return { valid: true, hint: 'json_value' };
    case 'object_comma_or_end': return { valid: true, hint: ', or }' };
    case 'array_start_or_val': return { valid: true, hint: 'json_value or ]' };
    case 'array_comma_or_end': return { valid: true, hint: ', or ]' };
  }
}

export const ToolCallJsonGrammar = {
  isValidToolJsonPrefix(partial: string): boolean {
    return analyzeJsonPrefix(partial).valid;
  },
  allowedNextTokenHint(partial: string): string {
    return analyzeJsonPrefix(partial).hint;
  },
};
