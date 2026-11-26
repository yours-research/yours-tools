import { describe, expect, it, vi } from 'vitest';
import { runSandbox } from '../src/sandbox/sandbox.js';

describe('Air-Gapped Sandbox (run_sandbox / js_calc)', () => {
  it('evaluates deterministic math, unit conversions, dates, JSON paths, and CSV stats', async () => {
    const mathRes = await runSandbox({ mode: 'expr', expression: 'round(mean([10, 20, 30]) + sqrt(16), 2)' });
    expect(mathRes.ok).toBe(true);
    expect(mathRes.result).toBe(24);

    const unitRes = await runSandbox({ mode: 'unit', value: 2, from: 'GiB', to: 'MiB' });
    expect(unitRes.ok).toBe(true);
    expect(unitRes.result).toBe(2048);

    const dateRes = await runSandbox({ mode: 'date', dateA: '2026-01-01', dateB: '2026-01-31' });
    expect(dateRes.ok).toBe(true);
    expect(dateRes.result).toBe(30);

    const jsonRes = await runSandbox({
      mode: 'json',
      data: '{"models":[{"name":"Pragma-4B"}]}',
      path: '$.models[0].name',
    });
    expect(jsonRes.ok).toBe(true);
    expect(jsonRes.result).toBe('Pragma-4B');

    const csvRes = await runSandbox({ mode: 'csv', data: 'item,price\nA,10\nB,30' });
    expect(csvRes.ok).toBe(true);
    expect(csvRes.formatted).toContain('price: min=10, max=30, mean=20');
  });

  it('executes safe data transforms in air-gapped js mode', async () => {
    const res = await runSandbox({
      mode: 'js',
      data: [
        { name: 'a', score: 2 },
        { name: 'b', score: 8 },
        { name: 'c', score: 5 },
      ],
      code: `
        const high = data.filter(item => item.score >= 5);
        const total = high.reduce((acc, item) => acc + item.score, 0);
        return { count: high.length, total };
      `,
    });
    expect(res.ok).toBe(true);
    expect(res.engine).toBe('deterministic-ast');
    expect(res.result).toEqual({ count: 2, total: 13 });
  });

  it('blocks network, DOM, chrome, Node, and prototype escape attempts', async () => {
    const payloads = [
      'fetch("https://evil.example")',
      'chrome.tabs.query({})',
      'window.location.href',
      'document.cookie',
      'globalThis.process',
      'process.exit(1)',
      'require("fs")',
      'Function("return 1")()',
      'eval("1+1")',
      'data.__proto__',
      '({}).constructor',
    ];

    for (const code of payloads) {
      const res = await runSandbox({ mode: 'js', code });
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/forbidden|violation/i);
    }

    const protoPath = await runSandbox({
      mode: 'json',
      data: '{"a":1}',
      path: '__proto__.polluted',
    });
    expect(protoPath.ok).toBe(false);
  });

  it('enforces strict step/timeout and memory ceilings', async () => {
    const infiniteLoop = await runSandbox({
      mode: 'js',
      code: 'let i = 0; while (true) { i++; } return i;',
      timeout_ms: 50,
    });
    expect(infiniteLoop.ok).toBe(false);
    expect(infiniteLoop.error).toMatch(/timed\s*out|timeout|ceiling|exceeded/i);

    const memBomb = await runSandbox({
      mode: 'js',
      code: 'let s = "x"; for (let i = 0; i < 25; i++) { s = s + s; } return s.length;',
      memory_limit_bytes: 65536,
    });
    expect(memBomb.ok).toBe(false);
    expect(memBomb.error).toMatch(/memory|ceiling|exceeded/i);
  });

  it('supports pluggable QuickJS-WASM runtime adapter', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true, result: 42 });
    const res = await runSandbox(
      { mode: 'js', code: '6 * 7', timeout_ms: 250, memory_limit_bytes: 1048576 },
      { quickJsAdapter: { execute } },
    );
    expect(execute).toHaveBeenCalledWith('6 * 7', {
      data: undefined,
      timeoutMs: 250,
      memoryLimitBytes: 1048576,
    });
    expect(res.ok).toBe(true);
    expect(res.engine).toBe('quickjs-wasm');
    expect(res.result).toBe(42);
  });

  it('evaluates Math.pow and ** exponentiation directly in expr mode', async () => {
    const res1 = await runSandbox({
      mode: 'expr',
      expression: '12500 * Math.pow(1 + 0.0675 / 12, 12 * 7)',
    });
    expect(res1.ok).toBe(true);
    expect(Number(res1.result)).toBeCloseTo(20023.4623, 3);

    const res2 = await runSandbox({
      mode: 'expr',
      expression: 'round(12500 * (1 + 0.0675 / 12) ** (12 * 7), 2)',
    });
    expect(res2.ok).toBe(true);
    expect(res2.result).toBe(20023.46);
  });
});
