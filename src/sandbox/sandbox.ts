import type { QuickJsRuntimeAdapter, RunSandboxInput, RunSandboxResult } from '../types.js';

type TokenType = 'number' | 'string' | 'ident' | 'op' | 'lparen' | 'rparen' | 'lbracket' | 'rbracket' | 'comma';
interface Token {
  type: TokenType;
  value: string;
}
type CalcValue = number | string | boolean | CalcValue[];

const LENGTH_TO_METERS: Record<string, number> = {
  mm: 0.001, millimeter: 0.001, millimeters: 0.001,
  cm: 0.01, centimeter: 0.01, centimeters: 0.01,
  m: 1, meter: 1, meters: 1,
  km: 1000, kilometer: 1000, kilometers: 1000,
  in: 0.0254, inch: 0.0254, inches: 0.0254,
  ft: 0.3048, foot: 0.3048, feet: 0.3048,
  yd: 0.9144, yard: 0.9144, yards: 0.9144,
  mi: 1609.344, mile: 1609.344, miles: 1609.344,
};

const MASS_TO_GRAMS: Record<string, number> = {
  mg: 0.001, milligram: 0.001, milligrams: 0.001,
  g: 1, gram: 1, grams: 1,
  kg: 1000, kilogram: 1000, kilograms: 1000,
  oz: 28.349523125, ounce: 28.349523125, ounces: 28.349523125,
  lb: 453.59237, lbs: 453.59237, pound: 453.59237, pounds: 453.59237,
};

const DATA_TO_BYTES: Record<string, number> = {
  B: 1, b: 1,
  KB: 1e3, kb: 1e3, KiB: 1024, kib: 1024,
  MB: 1e6, mb: 1e6, MiB: 1024 ** 2, mib: 1024 ** 2,
  GB: 1e9, gb: 1e9, GiB: 1024 ** 3, gib: 1024 ** 3,
  TB: 1e12, tb: 1e12, TiB: 1024 ** 4, tib: 1024 ** 4,
};

const TIME_TO_SECONDS: Record<string, number> = {
  ms: 0.001, millisecond: 0.001, milliseconds: 0.001,
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1,
  min: 60, mins: 60, minute: 60, minutes: 60,
  hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  day: 86400, days: 86400,
};

function normalizeTempUnit(unit: string): 'C' | 'F' | 'K' | null {
  const lower = unit.trim().toLowerCase();
  if (lower === 'c' || lower === 'celsius' || lower === '°c') return 'C';
  if (lower === 'f' || lower === 'fahrenheit' || lower === '°f') return 'F';
  if (lower === 'k' || lower === 'kelvin') return 'K';
  return null;
}

export function convertUnit(val: number, fromUnit: string, toUnit: string): number {
  if (!Number.isFinite(val)) throw new Error('Value to convert must be a finite number.');
  const fromTrim = fromUnit.trim();
  const toTrim = toUnit.trim();
  const fromLower = fromTrim.toLowerCase();
  const toLower = toTrim.toLowerCase();

  const fromTemp = normalizeTempUnit(fromTrim);
  const toTemp = normalizeTempUnit(toTrim);
  if (fromTemp && toTemp) {
    let celsius = val;
    if (fromTemp === 'F') celsius = ((val - 32) * 5) / 9;
    else if (fromTemp === 'K') celsius = val - 273.15;
    if (toTemp === 'C') return celsius;
    if (toTemp === 'F') return (celsius * 9) / 5 + 32;
    return celsius + 273.15;
  }

  const dataFrom = DATA_TO_BYTES[fromTrim] ?? DATA_TO_BYTES[fromLower];
  const dataTo = DATA_TO_BYTES[toTrim] ?? DATA_TO_BYTES[toLower];
  if (dataFrom !== undefined && dataTo !== undefined) {
    return (val * dataFrom) / dataTo;
  }

  for (const table of [LENGTH_TO_METERS, MASS_TO_GRAMS, TIME_TO_SECONDS]) {
    if (table[fromLower] !== undefined && table[toLower] !== undefined) {
      return (val * table[fromLower]) / table[toLower];
    }
  }

  throw new Error(`Unsupported or incompatible unit conversion: "${fromUnit}" -> "${toUnit}".`);
}

function parseIsoDateUtcMs(iso: string): number {
  const trimmed = iso.trim();
  if (!trimmed) throw new Error('Date string cannot be empty.');
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (dateOnly) {
    const year = Number.parseInt(dateOnly[1], 10);
    const month = Number.parseInt(dateOnly[2], 10) - 1;
    const day = Number.parseInt(dateOnly[3], 10);
    const ms = Date.UTC(year, month, day);
    const check = new Date(ms);
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month || check.getUTCDate() !== day) {
      throw new Error(`Invalid calendar date: "${iso}".`);
    }
    return ms;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ISO date: "${iso}".`);
  return parsed;
}

function calcDaysBetween(isoA: string, isoB: string): number {
  const diffDays = (parseIsoDateUtcMs(isoB) - parseIsoDateUtcMs(isoA)) / 86_400_000;
  return Math.round(diffDays * 1e9) / 1e9;
}

function calcAddDays(iso: string, days: number): string {
  if (!Number.isFinite(days)) throw new Error('Days offset must be a finite number.');
  const target = new Date(parseIsoDateUtcMs(iso) + days * 86_400_000);
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso.trim()) && Number.isInteger(days)) {
    return target.toISOString().slice(0, 10);
  }
  return target.toISOString();
}

function tokenizeExpr(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9]/.test(ch) || (ch === '.' && i + 1 < expr.length && /[0-9]/.test(expr[i + 1]))) {
      const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(expr.slice(i));
      if (!m) throw new Error(`Invalid number near "${expr.slice(i, i + 10)}".`);
      tokens.push({ type: 'number', value: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let str = '';
      i++;
      let closed = false;
      while (i < expr.length) {
        if (expr[i] === '\\' && i + 1 < expr.length) { str += expr[i + 1]; i += 2; continue; }
        if (expr[i] === quote) { closed = true; i++; break; }
        str += expr[i++];
      }
      if (!closed) throw new Error('Unterminated string literal in expression.');
      tokens.push({ type: 'string', value: str });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?/.exec(expr.slice(i));
      if (m) {
        const rawIdent = m[0];
        const ident = rawIdent.startsWith('Math.') ? rawIdent.slice(5) : rawIdent;
        tokens.push({ type: 'ident', value: ident });
        i += rawIdent.length;
        continue;
      }
    }
    if (ch === '*' && expr[i + 1] === '*') {
      tokens.push({ type: 'op', value: '^' });
      i += 2;
      continue;
    }
    if ('+-*/%^'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue; }
    if (ch === '(') { tokens.push({ type: 'lparen', value: ch }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen', value: ch }); i++; continue; }
    if (ch === '[') { tokens.push({ type: 'lbracket', value: ch }); i++; continue; }
    if (ch === ']') { tokens.push({ type: 'rbracket', value: ch }); i++; continue; }
    if (ch === ',') { tokens.push({ type: 'comma', value: ch }); i++; continue; }
    throw new Error(`Unexpected character "${ch}" at position ${i}.`);
  }
  return tokens;
}

function asNumber(val: CalcValue, context: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) {
    throw new Error(`Expected finite number for ${context}.`);
  }
  return val;
}

function asString(val: CalcValue, context: string): string {
  if (typeof val !== 'string') throw new Error(`Expected string for ${context}.`);
  return val;
}

function flattenNumbers(args: CalcValue[], fnName: string): number[] {
  const nums: number[] = [];
  for (const arg of args) {
    if (Array.isArray(arg)) {
      for (const item of arg) nums.push(asNumber(item, fnName));
    } else {
      nums.push(asNumber(arg, fnName));
    }
  }
  return nums;
}

function invokeMathFn(name: string, args: CalcValue[]): CalcValue {
  const fn = name.toLowerCase();
  switch (fn) {
    case 'sqrt': if (args.length !== 1) throw new Error('sqrt(x) requires 1 argument.'); return Math.sqrt(asNumber(args[0], 'sqrt'));
    case 'abs': if (args.length !== 1) throw new Error('abs(x) requires 1 argument.'); return Math.abs(asNumber(args[0], 'abs'));
    case 'round': {
      if (args.length < 1 || args.length > 2) throw new Error('round(x, digits?) takes 1 or 2 arguments.');
      const x = asNumber(args[0], 'round');
      if (args.length === 2) {
        const factor = 10 ** Math.trunc(asNumber(args[1], 'round digits'));
        return Math.round(x * factor) / factor;
      }
      return Math.round(x);
    }
    case 'floor': if (args.length !== 1) throw new Error('floor(x) requires 1 argument.'); return Math.floor(asNumber(args[0], 'floor'));
    case 'ceil': if (args.length !== 1) throw new Error('ceil(x) requires 1 argument.'); return Math.ceil(asNumber(args[0], 'ceil'));
    case 'sin': if (args.length !== 1) throw new Error('sin(x) requires 1 argument.'); return Math.sin(asNumber(args[0], 'sin'));
    case 'cos': if (args.length !== 1) throw new Error('cos(x) requires 1 argument.'); return Math.cos(asNumber(args[0], 'cos'));
    case 'tan': if (args.length !== 1) throw new Error('tan(x) requires 1 argument.'); return Math.tan(asNumber(args[0], 'tan'));
    case 'log': if (args.length !== 1) throw new Error('log(x) requires 1 argument.'); return Math.log(asNumber(args[0], 'log'));
    case 'log10': if (args.length !== 1) throw new Error('log10(x) requires 1 argument.'); return Math.log10(asNumber(args[0], 'log10'));
    case 'exp': if (args.length !== 1) throw new Error('exp(x) requires 1 argument.'); return Math.exp(asNumber(args[0], 'exp'));
    case 'pow': if (args.length !== 2) throw new Error('pow(base, exp) requires 2 arguments.'); return Math.pow(asNumber(args[0], 'pow'), asNumber(args[1], 'pow'));
    case 'min': { const nums = flattenNumbers(args, 'min'); if (!nums.length) throw new Error('min() requires >= 1 number.'); return Math.min(...nums); }
    case 'max': { const nums = flattenNumbers(args, 'max'); if (!nums.length) throw new Error('max() requires >= 1 number.'); return Math.max(...nums); }
    case 'sum': return flattenNumbers(args, 'sum').reduce((a, b) => a + b, 0);
    case 'mean':
    case 'avg': {
      const nums = flattenNumbers(args, fn);
      if (!nums.length) throw new Error(`${fn}() requires >= 1 number.`);
      return nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case 'median': {
      const nums = flattenNumbers(args, 'median').sort((a, b) => a - b);
      if (!nums.length) throw new Error('median() requires >= 1 number.');
      const mid = Math.floor(nums.length / 2);
      return nums.length % 2 === 1 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
    }
    case 'std': {
      const nums = flattenNumbers(args, 'std');
      if (!nums.length) throw new Error('std() requires >= 1 number.');
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      return Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / nums.length);
    }
    case 'count': return args.length === 1 && Array.isArray(args[0]) ? args[0].length : args.length;
    case 'convert':
      if (args.length !== 3) throw new Error('convert(val, from, to) requires 3 arguments.');
      return convertUnit(asNumber(args[0], 'val'), asString(args[1], 'from'), asString(args[2], 'to'));
    case 'daysbetween':
      if (args.length !== 2) throw new Error('daysBetween(a, b) requires 2 arguments.');
      return calcDaysBetween(asString(args[0], 'a'), asString(args[1], 'b'));
    case 'adddays':
      if (args.length !== 2) throw new Error('addDays(iso, days) requires 2 arguments.');
      return calcAddDays(asString(args[0], 'iso'), asNumber(args[1], 'days'));
    default:
      throw new Error(`Unknown function "${name}".`);
  }
}

function evaluateExpression(expr: string): CalcValue {
  const tokens = tokenizeExpr(expr);
  if (!tokens.length) throw new Error('Expression is empty.');
  let cursor = 0;
  const peek = () => tokens[cursor];
  const consume = () => tokens[cursor++];

  function parseAddSub(): CalcValue {
    let left = parseMulDiv();
    while (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseMulDiv();
      left = op === '+' ? asNumber(left, op) + asNumber(right, op) : asNumber(left, op) - asNumber(right, op);
    }
    return left;
  }

  function parseMulDiv(): CalcValue {
    let left = parseUnary();
    while (peek()?.type === 'op' && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
      const op = consume().value;
      const right = parseUnary();
      const l = asNumber(left, op);
      const r = asNumber(right, op);
      if ((op === '/' || op === '%') && r === 0) throw new Error('Division by zero.');
      left = op === '*' ? l * r : op === '/' ? l / r : l % r;
    }
    return left;
  }

  function parseUnary(): CalcValue {
    if (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const v = asNumber(parseUnary(), op);
      return op === '-' ? -v : v;
    }
    return parsePower();
  }

  function parsePower(): CalcValue {
    const base = parsePrimary();
    if (peek()?.type === 'op' && peek().value === '^') {
      consume();
      return Math.pow(asNumber(base, '^'), asNumber(parseUnary(), '^'));
    }
    return base;
  }

  function parsePrimary(): CalcValue {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of expression.');
    if (tok.type === 'number') { consume(); return Number(tok.value); }
    if (tok.type === 'string') { consume(); return tok.value; }
    if (tok.type === 'lparen') {
      consume();
      const val = parseAddSub();
      if (peek()?.type !== 'rparen') throw new Error('Expected closing ")".');
      consume();
      return val;
    }
    if (tok.type === 'lbracket') {
      consume();
      const items: CalcValue[] = [];
      if (peek()?.type !== 'rbracket') {
        items.push(parseAddSub());
        while (peek()?.type === 'comma') { consume(); items.push(parseAddSub()); }
      }
      if (peek()?.type !== 'rbracket') throw new Error('Expected closing "]".');
      consume();
      return items;
    }
    if (tok.type === 'ident') {
      consume();
      if (peek()?.type === 'lparen') {
        consume();
        const args: CalcValue[] = [];
        if (peek()?.type !== 'rparen') {
          args.push(parseAddSub());
          while (peek()?.type === 'comma') { consume(); args.push(parseAddSub()); }
        }
        if (peek()?.type !== 'rparen') throw new Error(`Expected closing ")" after ${tok.value}().`);
        consume();
        return invokeMathFn(tok.value, args);
      }
      const lower = tok.value.toLowerCase();
      if (lower === 'pi') return Math.PI;
      if (lower === 'e') return Math.E;
      if (lower === 'true') return true;
      if (lower === 'false') return false;
      throw new Error(`Unknown identifier "${tok.value}".`);
    }
    throw new Error(`Unexpected token "${tok.value}".`);
  }

  const value = parseAddSub();
  if (cursor < tokens.length) throw new Error(`Unexpected trailing token "${tokens[cursor].value}".`);
  return value;
}

function queryJsonPath(rawData: unknown, path?: string): unknown {
  const obj = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  if (!path || !path.trim()) return obj;
  const cleanedPath = path.trim().replace(/^\$\.?/, '');
  if (!cleanedPath) return obj;

  const segments: Array<string | number> = [];
  const segRegex = /([^.[\]]+)|\[(\d+|"[^"]*"|'[^']*')\]/g;
  let match: RegExpExecArray | null;
  while ((match = segRegex.exec(cleanedPath)) !== null) {
    if (match[1] !== undefined) segments.push(match[1]);
    else if (match[2] !== undefined) {
      const idxRaw = match[2];
      segments.push(/^\d+$/.test(idxRaw) ? Number.parseInt(idxRaw, 10) : idxRaw.slice(1, -1));
    }
  }

  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof seg === 'number' && Array.isArray(current)) current = current[seg];
    else if (typeof current === 'object') {
      const key = String(seg);
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new Error(`Blocked unsafe property access "${key}".`);
      }
      current = (current as Record<string, unknown>)[key];
    } else return undefined;
  }
  return current;
}

function parseCsvRows(csvText: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"' && csvText[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
      continue;
    }
    if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field.trim()); field = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && csvText[i + 1] === '\n') i++;
      row.push(field.trim());
      if (row.some((c) => c !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}

function summarizeCsv(csvText: string): {
  rowCount: number;
  columns: string[];
  numericStats: Record<string, { count: number; min: number; max: number; mean: number }>;
} {
  const rows = parseCsvRows(csvText);
  if (rows.length === 0) throw new Error('CSV input is empty.');
  const columns = rows[0];
  const dataRows = rows.slice(1);
  const numericStats: Record<string, { count: number; min: number; max: number; mean: number }> = {};
  for (let colIdx = 0; colIdx < columns.length; colIdx++) {
    const colName = columns[colIdx] || `col_${colIdx}`;
    const values: number[] = [];
    for (const r of dataRows) {
      const cell = r[colIdx];
      if (cell !== undefined && cell !== '') {
        const num = Number(cell);
        if (Number.isFinite(num)) values.push(num);
      }
    }
    if (values.length > 0) {
      const sum = values.reduce((a, b) => a + b, 0);
      numericStats[colName] = {
        count: values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        mean: Math.round((sum / values.length) * 1e6) / 1e6,
      };
    }
  }
  return { rowCount: dataRows.length, columns, numericStats };
}

// ============================================================================
// Air-Gapped AST-Based Sandboxed JS Subset Interpreter (Zero eval/Function/Globals)
// ============================================================================

const FORBIDDEN_SANDBOX_IDENTIFIERS = new Set([
  'globalThis',
  'window',
  'self',
  'document',
  'chrome',
  'browser',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'location',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'importScripts',
  'eval',
  'Function',
  'process',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'Buffer',
  'Reflect',
  'Proxy',
  '__proto__',
  'constructor',
  'prototype',
]);

type JsTokenKind = 'num' | 'str' | 'ident' | 'op' | 'punct';
interface JsToken {
  kind: JsTokenKind;
  value: string;
}

function tokenizeJs(code: string): JsToken[] {
  const out: JsToken[] = [];
  let i = 0;
  const twoCharOps = new Set(['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '=>', '++', '--', '+=', '-=', '*=', '/=']);
  while (i < code.length) {
    const ch = code[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (code.slice(i, i + 2) === '//') {
      while (i < code.length && code[i] !== '\n') i++;
      continue;
    }
    if (code.slice(i, i + 2) === '/*') {
      const end = code.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated block comment.');
      i = end + 2;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      const m = /^(?:\d+(?:\.\d*)?)(?:[eE][+-]?\d+)?/.exec(code.slice(i));
      if (!m) throw new Error(`Invalid number near "${code.slice(i, i + 8)}".`);
      out.push({ kind: 'num', value: m[0] });
      i += m[0].length;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = ch;
      let str = '';
      i++;
      let closed = false;
      while (i < code.length) {
        if (code[i] === '\\' && i + 1 < code.length) {
          const esc = code[i + 1];
          str += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
          continue;
        }
        if (code[i] === q) { closed = true; i++; break; }
        str += code[i++];
      }
      if (!closed) throw new Error('Unterminated string literal.');
      out.push({ kind: 'str', value: str });
      continue;
    }
    if (/[a-zA-Z_$]/.test(ch)) {
      const m = /^[a-zA-Z_$][a-zA-Z0-9_$]*/.exec(code.slice(i));
      if (m) {
        if (FORBIDDEN_SANDBOX_IDENTIFIERS.has(m[0])) {
          throw new Error(`Sandbox security violation: access to "${m[0]}" is forbidden.`);
        }
        out.push({ kind: 'ident', value: m[0] });
        i += m[0].length;
        continue;
      }
    }
    const three = code.slice(i, i + 3);
    const two = code.slice(i, i + 2);
    if (twoCharOps.has(three)) { out.push({ kind: 'op', value: three }); i += 3; continue; }
    if (twoCharOps.has(two)) { out.push({ kind: 'op', value: two }); i += 2; continue; }
    if ('+-*/%<>=!'.includes(ch)) { out.push({ kind: 'op', value: ch }); i++; continue; }
    if ('(){}[],.;:'.includes(ch)) { out.push({ kind: 'punct', value: ch }); i++; continue; }
    throw new Error(`Unsupported character "${ch}" in sandbox code.`);
  }
  return out;
}

class SandboxAbortError extends Error {}

function executeAirGappedJsSubset(
  code: string,
  dataInput: unknown,
  timeoutMs: number,
  memoryLimitBytes: number,
): unknown {
  const tokens = tokenizeJs(code);
  const startMs = Date.now();
  const maxSteps = 50_000;
  let steps = 0;
  let allocatedBytes = 0;

  const checkBudget = (bytesDelta = 0) => {
    steps++;
    allocatedBytes += bytesDelta;
    if (allocatedBytes > memoryLimitBytes) {
      throw new SandboxAbortError(`Sandbox memory limit exceeded (${memoryLimitBytes} bytes).`);
    }
    if (steps > maxSteps) {
      throw new SandboxAbortError(`Sandbox step/timeout ceiling exceeded (${timeoutMs}ms).`);
    }
    if ((steps & 255) === 0 && Date.now() - startMs > timeoutMs) {
      throw new SandboxAbortError(`Sandbox execution timed out after ${timeoutMs}ms.`);
    }
  };

  type Scope = Map<string, { value: unknown; isConst: boolean }>;
  const rootScope: Scope = new Map();
  rootScope.set('data', { value: dataInput === undefined ? null : structuredClone(dataInput), isConst: true });
  rootScope.set('Math', { value: Math, isConst: true });
  rootScope.set('JSON', { value: { parse: JSON.parse, stringify: JSON.stringify }, isConst: true });
  rootScope.set('Number', { value: Number, isConst: true });
  rootScope.set('String', { value: String, isConst: true });
  rootScope.set('Boolean', { value: Boolean, isConst: true });
  rootScope.set('Array', { value: { isArray: Array.isArray }, isConst: true });
  rootScope.set('Object', {
    value: { keys: Object.keys, values: Object.values, entries: Object.entries },
    isConst: true,
  });

  const lookupVar = (scopes: Scope[], name: string): unknown => {
    for (let s = scopes.length - 1; s >= 0; s--) {
      if (scopes[s].has(name)) return scopes[s].get(name)!.value;
    }
    throw new Error(`ReferenceError: "${name}" is not defined in air-gapped sandbox.`);
  };

  const assignVar = (scopes: Scope[], name: string, value: unknown): unknown => {
    for (let s = scopes.length - 1; s >= 0; s--) {
      const entry = scopes[s].get(name);
      if (entry) {
        if (entry.isConst) throw new Error(`TypeError: Assignment to constant variable "${name}".`);
        entry.value = value;
        return value;
      }
    }
    throw new Error(`ReferenceError: "${name}" is not defined.`);
  };

  let pos = 0;
  const peek = (offset = 0) => tokens[pos + offset];
  const next = () => tokens[pos++];

  type ReturnSignal = { __return: true; value: unknown };
  const isReturn = (v: unknown): v is ReturnSignal =>
    Boolean(v && typeof v === 'object' && (v as ReturnSignal).__return === true);

  function evalStatements(scopes: Scope[], stopOnBrace: boolean): unknown {
    let lastVal: unknown = undefined;
    while (pos < tokens.length) {
      checkBudget();
      if (stopOnBrace && peek()?.kind === 'punct' && peek()?.value === '}') {
        break;
      }
      if (peek()?.kind === 'punct' && peek()?.value === ';') {
        next();
        continue;
      }
      const res = evalStatement(scopes);
      if (isReturn(res)) return res;
      lastVal = res;
    }
    return lastVal;
  }

  function evalBlock(scopes: Scope[]): unknown {
    if (peek()?.value !== '{') throw new Error('Expected "{".');
    next();
    const childScopes = [...scopes, new Map()];
    const res = evalStatements(childScopes, true);
    if (peek()?.value !== '}') throw new Error('Expected "}".');
    next();
    return res;
  }

  function skipBalancedBlock(): void {
    if (peek()?.value !== '{') {
      while (pos < tokens.length && peek()?.value !== ';') pos++;
      if (peek()?.value === ';') pos++;
      return;
    }
    let depth = 0;
    while (pos < tokens.length) {
      const t = next();
      if (t.value === '{') depth++;
      else if (t.value === '}') {
        depth--;
        if (depth === 0) return;
      }
    }
  }

  function evalStatement(scopes: Scope[]): unknown {
    checkBudget();
    const tok = peek();
    if (!tok) return undefined;

    if (tok.kind === 'ident' && (tok.value === 'const' || tok.value === 'let' || tok.value === 'var')) {
      const declKind = next().value;
      const nameTok = next();
      if (!nameTok || nameTok.kind !== 'ident') throw new Error('Expected variable name.');
      let initVal: unknown = undefined;
      if (peek()?.value === '=') {
        next();
        initVal = evalExpr(scopes);
      }
      scopes[scopes.length - 1].set(nameTok.value, { value: initVal, isConst: declKind === 'const' });
      if (peek()?.value === ';') next();
      return initVal;
    }

    if (tok.kind === 'ident' && tok.value === 'return') {
      next();
      if (peek()?.value === ';' || peek()?.value === '}') {
        if (peek()?.value === ';') next();
        return { __return: true, value: undefined } satisfies ReturnSignal;
      }
      const value = evalExpr(scopes);
      if (peek()?.value === ';') next();
      return { __return: true, value } satisfies ReturnSignal;
    }

    if (tok.kind === 'ident' && tok.value === 'if') {
      next();
      if (next()?.value !== '(') throw new Error('Expected "(" after if.');
      const cond = evalExpr(scopes);
      if (next()?.value !== ')') throw new Error('Expected ")" after if condition.');
      let res: unknown = undefined;
      if (cond) {
        res = peek()?.value === '{' ? evalBlock(scopes) : evalStatement(scopes);
      } else {
        skipBalancedBlock();
      }
      if (peek()?.kind === 'ident' && peek()?.value === 'else') {
        next();
        if (!cond) {
          res = peek()?.value === '{' ? evalBlock(scopes) : evalStatement(scopes);
        } else {
          skipBalancedBlock();
        }
      }
      return res;
    }

    if (tok.kind === 'ident' && tok.value === 'while') {
      next();
      if (next()?.value !== '(') throw new Error('Expected "(" after while.');
      const condStart = pos;
      let lastVal: unknown = undefined;
      while (true) {
        checkBudget();
        pos = condStart;
        const cond = evalExpr(scopes);
        if (next()?.value !== ')') throw new Error('Expected ")" after while condition.');
        if (!cond) {
          skipBalancedBlock();
          break;
        }
        const bodyRes = peek()?.value === '{' ? evalBlock(scopes) : evalStatement(scopes);
        if (isReturn(bodyRes)) return bodyRes;
        lastVal = bodyRes;
      }
      return lastVal;
    }

    if (tok.kind === 'ident' && tok.value === 'for') {
      next();
      if (next()?.value !== '(') throw new Error('Expected "(" after for.');
      const loopScope: Scope = new Map();
      const loopScopes = [...scopes, loopScope];
      if (peek()?.value !== ';') evalStatement(loopScopes);
      else next();

      const condStart = pos;
      // Find stepStart and bodyStart by scanning
      while (pos < tokens.length && peek()?.value !== ';') pos++;
      if (next()?.value !== ';') throw new Error('Expected ";" in for loop.');
      const stepStart = pos;
      let parenDepth = 1;
      while (pos < tokens.length && parenDepth > 0) {
        const t = next();
        if (t.value === '(') parenDepth++;
        else if (t.value === ')') parenDepth--;
      }
      const bodyStart = pos;

      let lastVal: unknown = undefined;
      while (true) {
        checkBudget();
        pos = condStart;
        const cond = peek()?.value === ';' ? true : evalExpr(loopScopes);
        pos = bodyStart;
        if (!cond) {
          skipBalancedBlock();
          break;
        }
        const res = peek()?.value === '{' ? evalBlock(loopScopes) : evalStatement(loopScopes);
        if (isReturn(res)) return res;
        lastVal = res;
        pos = stepStart;
        if (peek()?.value !== ')') evalExpr(loopScopes);
      }
      return lastVal;
    }

    const val = evalExpr(scopes);
    if (peek()?.value === ';') next();
    return val;
  }

  function evalExpr(scopes: Scope[]): unknown {
    return evalAssign(scopes);
  }

  function evalAssign(scopes: Scope[]): unknown {
    if (
      peek()?.kind === 'ident' &&
      peek(1)?.kind === 'op' &&
      ['=', '+=', '-=', '*=', '/='].includes(peek(1)!.value)
    ) {
      const name = next().value;
      const op = next().value;
      const rhs = evalAssign(scopes);
      if (op === '=') return assignVar(scopes, name, rhs);
      const cur = Number(lookupVar(scopes, name));
      const nRhs = Number(rhs);
      if (op === '+=') return assignVar(scopes, name, cur + nRhs);
      if (op === '-=') return assignVar(scopes, name, cur - nRhs);
      if (op === '*=') return assignVar(scopes, name, cur * nRhs);
      return assignVar(scopes, name, cur / nRhs);
    }
    return evalOr(scopes);
  }

  function evalOr(scopes: Scope[]): unknown {
    let left = evalAnd(scopes);
    while (peek()?.value === '||') {
      next();
      const right = evalAnd(scopes);
      left = left || right;
    }
    return left;
  }

  function evalAnd(scopes: Scope[]): unknown {
    let left = evalEq(scopes);
    while (peek()?.value === '&&') {
      next();
      const right = evalEq(scopes);
      left = left && right;
    }
    return left;
  }

  function evalEq(scopes: Scope[]): unknown {
    let left = evalRel(scopes);
    while (peek()?.kind === 'op' && ['===', '!==', '==', '!='].includes(peek()!.value)) {
      const op = next().value;
      const right = evalRel(scopes);
      if (op === '===') left = left === right;
      else if (op === '!==') left = left !== right;
      else if (op === '==') left = left == right;
      else left = left != right;
    }
    return left;
  }

  function evalRel(scopes: Scope[]): unknown {
    let left = evalAdd(scopes);
    while (peek()?.kind === 'op' && ['<', '>', '<=', '>='].includes(peek()!.value)) {
      const op = next().value;
      const right = evalAdd(scopes);
      if (op === '<') left = (left as number) < (right as number);
      else if (op === '>') left = (left as number) > (right as number);
      else if (op === '<=') left = (left as number) <= (right as number);
      else left = (left as number) >= (right as number);
    }
    return left;
  }

  function evalAdd(scopes: Scope[]): unknown {
    let left = evalMul(scopes);
    while (peek()?.kind === 'op' && (peek()!.value === '+' || peek()!.value === '-')) {
      const op = next().value;
      const right = evalMul(scopes);
      if (op === '+') {
        if (typeof left === 'string' || typeof right === 'string') {
          const joined = `${String(left)}${String(right)}`;
          checkBudget(joined.length * 2);
          left = joined;
        } else {
          left = Number(left) + Number(right);
        }
      } else {
        left = Number(left) - Number(right);
      }
    }
    return left;
  }

  function evalMul(scopes: Scope[]): unknown {
    let left = evalUnary(scopes);
    while (peek()?.kind === 'op' && ['*', '/', '%'].includes(peek()!.value)) {
      const op = next().value;
      const right = evalUnary(scopes);
      const l = Number(left);
      const r = Number(right);
      if ((op === '/' || op === '%') && r === 0) throw new Error('Division by zero.');
      left = op === '*' ? l * r : op === '/' ? l / r : l % r;
    }
    return left;
  }

  function evalUnary(scopes: Scope[]): unknown {
    if (peek()?.kind === 'op' && ['!', '-', '+'].includes(peek()!.value)) {
      const op = next().value;
      const val = evalUnary(scopes);
      if (op === '!') return !val;
      return op === '-' ? -Number(val) : +Number(val);
    }
    return evalPostfix(scopes);
  }

  function invokeArrowOrFn(fnVal: unknown, thisArg: unknown, args: unknown[]): unknown {
    if (typeof fnVal === 'function') {
      return (fnVal as (...a: unknown[]) => unknown).apply(thisArg, args);
    }
    if (fnVal && typeof fnVal === 'object' && (fnVal as { __arrow?: boolean }).__arrow) {
      const arrow = fnVal as {
        params: string[];
        bodyStart: number;
        bodyEnd: number;
        isBlock: boolean;
        closureScopes: Scope[];
      };
      const savedPos = pos;
      const callScope: Scope = new Map();
      arrow.params.forEach((p, idx) => callScope.set(p, { value: args[idx], isConst: false }));
      const callScopes = [...arrow.closureScopes, callScope];
      pos = arrow.bodyStart;
      const res = arrow.isBlock ? evalBlock(callScopes) : evalExpr(callScopes);
      pos = savedPos;
      return isReturn(res) ? res.value : res;
    }
    throw new Error('Target is not callable in sandbox.');
  }

  function evalPostfix(scopes: Scope[]): unknown {
    let target = evalPrimary(scopes);
    while (pos < tokens.length) {
      checkBudget();
      if (peek()?.kind === 'op' && (peek()?.value === '++' || peek()?.value === '--')) {
        // Support post-increment only when preceding token was an identifier
        const prevTok = tokens[pos - 1];
        const op = next().value;
        if (prevTok?.kind === 'ident') {
          const cur = Number(lookupVar(scopes, prevTok.value));
          assignVar(scopes, prevTok.value, op === '++' ? cur + 1 : cur - 1);
          target = cur;
          continue;
        }
      }
      if (peek()?.value === '.') {
        next();
        const propTok = next();
        if (!propTok || propTok.kind !== 'ident') throw new Error('Expected property name.');
        const prop = propTok.value;
        if (FORBIDDEN_SANDBOX_IDENTIFIERS.has(prop)) {
          throw new Error(`Sandbox security violation: property "${prop}" is forbidden.`);
        }
        const parent = target;
        if (peek()?.value === '(') {
          next();
          const args: unknown[] = [];
          if (peek()?.value !== ')') {
            args.push(evalExpr(scopes));
            while (peek()?.value === ',') { next(); args.push(evalExpr(scopes)); }
          }
          if (next()?.value !== ')') throw new Error('Expected ")" after method arguments.');

          if (Array.isArray(parent)) {
            if (prop === 'map') target = parent.map((item, idx) => invokeArrowOrFn(args[0], parent, [item, idx]));
            else if (prop === 'filter') target = parent.filter((item, idx) => Boolean(invokeArrowOrFn(args[0], parent, [item, idx])));
            else if (prop === 'reduce') {
              target = args.length >= 2
                ? parent.reduce((acc, item, idx) => invokeArrowOrFn(args[0], parent, [acc, item, idx]), args[1])
                : parent.reduce((acc, item, idx) => invokeArrowOrFn(args[0], parent, [acc, item, idx]));
            } else if (prop === 'slice' || prop === 'join' || prop === 'includes' || prop === 'indexOf') {
              target = (parent[prop] as (...a: unknown[]) => unknown)(...args);
            } else {
              throw new Error(`Array method ".${prop}" is not allowed in sandbox.`);
            }
            continue;
          }
          if (parent !== null && parent !== undefined && (typeof parent === 'object' || typeof parent === 'string')) {
            const method = (parent as Record<string, unknown>)[prop];
            if (typeof method !== 'function') throw new Error(`"${prop}" is not a function.`);
            target = method.apply(parent, args);
            continue;
          }
          throw new Error(`Cannot call ".${prop}" on ${String(parent)}.`);
        }
        if (parent === null || parent === undefined) {
          throw new Error(`Cannot read properties of ${String(parent)} (reading "${prop}").`);
        }
        target = (parent as Record<string, unknown>)[prop];
        continue;
      }
      if (peek()?.value === '[') {
        next();
        const key = evalExpr(scopes);
        if (next()?.value !== ']') throw new Error('Expected "]".');
        if (typeof key === 'string' && FORBIDDEN_SANDBOX_IDENTIFIERS.has(key)) {
          throw new Error(`Sandbox security violation: property "${key}" is forbidden.`);
        }
        if (target === null || target === undefined) throw new Error('Cannot index null or undefined.');
        target = (target as Record<string, unknown>)[String(key)];
        continue;
      }
      if (peek()?.value === '(') {
        next();
        const args: unknown[] = [];
        if (peek()?.value !== ')') {
          args.push(evalExpr(scopes));
          while (peek()?.value === ',') { next(); args.push(evalExpr(scopes)); }
        }
        if (next()?.value !== ')') throw new Error('Expected ")".');
        target = invokeArrowOrFn(target, null, args);
        continue;
      }
      break;
    }
    return target;
  }

  function evalPrimary(scopes: Scope[]): unknown {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end of sandbox code.');
    if (tok.kind === 'num') { next(); return Number(tok.value); }
    if (tok.kind === 'str') { next(); checkBudget(tok.value.length * 2); return tok.value; }
    if (tok.kind === 'ident') {
      next();
      if (tok.value === 'true') return true;
      if (tok.value === 'false') return false;
      if (tok.value === 'null') return null;
      if (tok.value === 'undefined') return undefined;
      if (peek()?.value === '=>') {
        next();
        const isBlock = peek()?.value === '{';
        const bodyStart = pos;
        if (isBlock) skipBalancedBlock();
        else while (pos < tokens.length && !',);}]'.includes(peek()!.value)) pos++;
        return { __arrow: true, params: [tok.value], bodyStart, bodyEnd: pos, isBlock, closureScopes: scopes };
      }
      return lookupVar(scopes, tok.value);
    }
    if (tok.value === '(') {
      // Check for arrow function `(a, b) => ...`
      const savePos = pos;
      next();
      const paramNames: string[] = [];
      let isArrowParams = true;
      if (peek()?.value !== ')') {
        while (pos < tokens.length) {
          const p = peek();
          if (p?.kind === 'ident') {
            paramNames.push(next().value);
            if (peek()?.value === ',') { next(); continue; }
            if (peek()?.value === ')') break;
          }
          isArrowParams = false;
          break;
        }
      }
      if (isArrowParams && peek()?.value === ')' && peek(1)?.value === '=>') {
        next(); // ')'
        next(); // '=>'
        const isBlock = peek()?.value === '{';
        const bodyStart = pos;
        if (isBlock) skipBalancedBlock();
        else while (pos < tokens.length && !',);}]'.includes(peek()!.value)) pos++;
        return { __arrow: true, params: paramNames, bodyStart, bodyEnd: pos, isBlock, closureScopes: scopes };
      }
      pos = savePos + 1;
      const val = evalExpr(scopes);
      if (next()?.value !== ')') throw new Error('Expected ")".');
      return val;
    }
    if (tok.value === '[') {
      next();
      const arr: unknown[] = [];
      if (peek()?.value !== ']') {
        arr.push(evalExpr(scopes));
        checkBudget(16);
        while (peek()?.value === ',') {
          next();
          if (peek()?.value === ']') break;
          arr.push(evalExpr(scopes));
          checkBudget(16);
        }
      }
      if (next()?.value !== ']') throw new Error('Expected "]".');
      return arr;
    }
    if (tok.value === '{') {
      next();
      const obj: Record<string, unknown> = {};
      if (peek()?.value !== '}') {
        while (pos < tokens.length) {
          const keyTok = next();
          if (!keyTok || (keyTok.kind !== 'ident' && keyTok.kind !== 'str')) {
            throw new Error('Expected object literal key.');
          }
          if (FORBIDDEN_SANDBOX_IDENTIFIERS.has(keyTok.value)) {
            throw new Error(`Blocked unsafe object key "${keyTok.value}".`);
          }
          if (keyTok.kind === 'ident' && peek()?.value !== ':') {
            obj[keyTok.value] = lookupVar(scopes, keyTok.value);
          } else {
            if (next()?.value !== ':') throw new Error('Expected ":" in object literal.');
            obj[keyTok.value] = evalExpr(scopes);
          }
          checkBudget(32);
          if (peek()?.value === ',') {
            next();
            if (peek()?.value === '}') break;
            continue;
          }
          break;
        }
      }
      if (next()?.value !== '}') throw new Error('Expected "}".');
      return obj;
    }
    throw new Error(`Unexpected token "${tok.value}".`);
  }

  const res = evalStatements([rootScope], false);
  return isReturn(res) ? res.value : res;
}

function formatResult(val: unknown): string {
  if (typeof val === 'number') {
    if (Number.isInteger(val)) return String(val);
    return String(Number(val.toPrecision(12)));
  }
  if (typeof val === 'string') return val;
  if (val === undefined) return 'undefined';
  return JSON.stringify(val);
}

export interface SandboxOptions {
  quickJsAdapter?: QuickJsRuntimeAdapter;
}

/**
 * Air-gapped sandbox executor (`run_sandbox` / legacy `js_calc`).
 * Enforces timeout and memory ceilings and blocks all network/DOM/chrome/global escapes.
 */
export async function runSandbox(
  input: RunSandboxInput,
  options?: SandboxOptions,
): Promise<RunSandboxResult> {
  const start = Date.now();
  const mode = input.mode ?? (typeof input.code === 'string' ? 'js' : 'expr');
  const timeoutMs = Math.max(10, Math.min(5000, input.timeout_ms ?? 1000));
  const memoryLimitBytes = Math.max(65536, Math.min(33_554_432, input.memory_limit_bytes ?? 8_388_608));

  try {
    if (mode === 'expr') {
      if (typeof input.expression !== 'string' || !input.expression.trim()) {
        return {
          ok: false,
          mode,
          engine: 'deterministic-ast',
          formatted: '',
          elapsedMs: Date.now() - start,
          error: 'Missing expression for mode "expr".',
        };
      }
      const value = evaluateExpression(input.expression);
      return {
        ok: true,
        mode,
        engine: 'deterministic-ast',
        result: value,
        formatted: formatResult(value),
        elapsedMs: Date.now() - start,
      };
    }

    if (mode === 'unit') {
      const numVal = typeof input.value === 'number' ? input.value : Number(input.value);
      if (!Number.isFinite(numVal) || !input.from || !input.to) {
        return {
          ok: false,
          mode,
          engine: 'deterministic-ast',
          formatted: '',
          elapsedMs: Date.now() - start,
          error: 'Unit mode requires numeric value, from, and to.',
        };
      }
      const converted = convertUnit(numVal, input.from, input.to);
      return {
        ok: true,
        mode,
        engine: 'deterministic-ast',
        result: converted,
        formatted: `${formatResult(converted)} ${input.to}`,
        elapsedMs: Date.now() - start,
      };
    }

    if (mode === 'date') {
      if (input.dateA && input.dateB) {
        const diff = calcDaysBetween(input.dateA, input.dateB);
        return {
          ok: true,
          mode,
          engine: 'deterministic-ast',
          result: diff,
          formatted: `${formatResult(diff)} days`,
          elapsedMs: Date.now() - start,
        };
      }
      const baseDate = input.dateA ?? (typeof input.value === 'string' ? input.value : undefined);
      if (baseDate && typeof input.days === 'number') {
        const nextDate = calcAddDays(baseDate, input.days);
        return {
          ok: true,
          mode,
          engine: 'deterministic-ast',
          result: nextDate,
          formatted: nextDate,
          elapsedMs: Date.now() - start,
        };
      }
      return {
        ok: false,
        mode,
        engine: 'deterministic-ast',
        formatted: '',
        elapsedMs: Date.now() - start,
        error: 'Date mode requires (dateA, dateB) or (dateA, days).',
      };
    }

    if (mode === 'json') {
      const source = input.data ?? input.value;
      if (source === undefined) {
        return {
          ok: false,
          mode,
          engine: 'deterministic-ast',
          formatted: '',
          elapsedMs: Date.now() - start,
          error: 'JSON mode requires data or value.',
        };
      }
      const extracted = queryJsonPath(source, input.path);
      return {
        ok: true,
        mode,
        engine: 'deterministic-ast',
        result: extracted,
        formatted: formatResult(extracted),
        elapsedMs: Date.now() - start,
      };
    }

    if (mode === 'csv') {
      if (typeof input.data !== 'string' || !input.data.trim()) {
        return {
          ok: false,
          mode,
          engine: 'deterministic-ast',
          formatted: '',
          elapsedMs: Date.now() - start,
          error: 'CSV mode requires non-empty data string.',
        };
      }
      const summary = summarizeCsv(input.data);
      const statLines = Object.entries(summary.numericStats).map(
        ([col, s]) => `${col}: min=${s.min}, max=${s.max}, mean=${s.mean} (n=${s.count})`,
      );
      return {
        ok: true,
        mode,
        engine: 'deterministic-ast',
        result: summary,
        formatted: [
          `Rows: ${summary.rowCount} | Columns (${summary.columns.length}): ${summary.columns.join(', ')}`,
          ...statLines,
        ].join('\n'),
        elapsedMs: Date.now() - start,
      };
    }

    if (mode === 'transform' || mode === 'js') {
      const code = input.code ?? input.expression ?? '';
      if (!code.trim()) {
        return {
          ok: false,
          mode,
          engine: options?.quickJsAdapter ? 'quickjs-wasm' : 'deterministic-ast',
          formatted: '',
          elapsedMs: Date.now() - start,
          error: `Mode "${mode}" requires non-empty code or expression.`,
        };
      }

      const parsedData =
        typeof input.data === 'string' && (input.data.trim().startsWith('{') || input.data.trim().startsWith('['))
          ? (() => {
              try {
                return JSON.parse(input.data);
              } catch {
                return input.data;
              }
            })()
          : input.data;

      if (options?.quickJsAdapter && mode === 'js') {
        const qjs = await options.quickJsAdapter.execute(code, {
          data: parsedData,
          timeoutMs,
          memoryLimitBytes,
        });
        return {
          ok: qjs.ok,
          mode,
          engine: 'quickjs-wasm',
          result: qjs.result,
          formatted: qjs.ok ? formatResult(qjs.result ?? qjs.stdout ?? '') : '',
          elapsedMs: Date.now() - start,
          ...(qjs.error ? { error: qjs.error } : {}),
        };
      }

      const value = executeAirGappedJsSubset(code, parsedData, timeoutMs, memoryLimitBytes);
      return {
        ok: true,
        mode,
        engine: 'deterministic-ast',
        result: value,
        formatted: formatResult(value),
        elapsedMs: Date.now() - start,
      };
    }

    return {
      ok: false,
      mode,
      engine: 'deterministic-ast',
      formatted: '',
      elapsedMs: Date.now() - start,
      error: `Unsupported sandbox mode: "${String(mode)}".`,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      mode,
      engine: options?.quickJsAdapter && mode === 'js' ? 'quickjs-wasm' : 'deterministic-ast',
      formatted: '',
      elapsedMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
