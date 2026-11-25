import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { executePageInteraction } from '../src/actions/interactPage.js';
import { extractSemanticSnapshot } from '../src/extractors/semanticAom.js';

function createInteractiveDom() {
  const html = `
    <!doctype html>
    <html>
      <head><title>Demo App</title></head>
      <body>
        <main>
          <form id="demo-form">
            <label for="q">Search Query</label>
            <input id="q" type="text" value="old" />
            <label for="secret">API Key</label>
            <input id="secret" type="password" />
            <label for="engine">Engine</label>
            <select id="engine">
              <option value="wgsl">WebGPU WGSL</option>
              <option value="wasm">CPU WASM</option>
            </select>
            <label><input id="agree" type="checkbox" /> Agree</label>
            <button id="run-btn" type="button">Execute</button>
            <button id="submit-btn" type="submit">Submit</button>
          </form>
          <a id="bad-link" href="javascript:alert(1)">Bad Link</a>
          <div id="status">Idle</div>
        </main>
      </body>
    </html>
  `;
  const dom = new JSDOM(html, { url: 'https://yours.sh/app' });
  const doc = dom.window.document;

  doc.getElementById('run-btn')!.addEventListener('click', () => {
    doc.getElementById('status')!.textContent = 'Completed run!';
  });
  doc.getElementById('demo-form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    doc.getElementById('status')!.textContent = 'Submitted!';
  });

  return dom;
}

describe('DOM Actions (interact_page)', () => {
  it('executes type, select, check, and click with settled DOM diffing', async () => {
    const dom = createInteractiveDom();
    const doc = dom.window.document;
    const { snapshot } = extractSemanticSnapshot(doc);

    const qId = snapshot.interactiveNodes.find((n) => n.name === 'Search Query')!.nodeId;
    const engineId = snapshot.interactiveNodes.find((n) => n.name === 'Engine')!.nodeId;
    const agreeId = snapshot.interactiveNodes.find((n) => n.role === 'checkbox')!.nodeId;
    const runId = snapshot.interactiveNodes.find((n) => n.name === 'Execute')!.nodeId;

    const typeRes = await executePageInteraction(doc, { action: 'type', node_id: qId, text: 'pragma 4b' });
    expect(typeRes.ok).toBe(true);
    expect((doc.getElementById('q') as HTMLInputElement).value).toBe('pragma 4b');
    expect(typeRes.result?.diff.changedControls.some((c) => c.nodeId === qId)).toBe(true);

    const selRes = await executePageInteraction(doc, { action: 'select', node_id: engineId, value: 'CPU WASM' });
    expect(selRes.ok).toBe(true);
    expect((doc.getElementById('engine') as HTMLSelectElement).value).toBe('wasm');

    const chkRes = await executePageInteraction(doc, { action: 'check', node_id: agreeId, checked: true });
    expect(chkRes.ok).toBe(true);
    expect((doc.getElementById('agree') as HTMLInputElement).checked).toBe(true);

    const clkRes = await executePageInteraction(doc, { action: 'click', node_id: runId });
    expect(clkRes.ok).toBe(true);
    expect(clkRes.result?.diff.addedTexts).toContain('Completed run!');
    expect(clkRes.result?.diff.removedTexts).toContain('Idle');
  });

  it('enforces safety gating on password inputs, form submits, and javascript: links', async () => {
    const dom = createInteractiveDom();
    const doc = dom.window.document;
    const { snapshot } = extractSemanticSnapshot(doc);

    const passId = snapshot.interactiveNodes.find((n) => n.name === 'API Key')!.nodeId;
    const badLinkId = snapshot.interactiveNodes.find((n) => n.name === 'Bad Link')!.nodeId;
    const submitId = snapshot.interactiveNodes.find((n) => n.name === 'Submit')!.nodeId;

    // Password input blocked without approval
    const blockedPass = await executePageInteraction(doc, {
      action: 'type',
      node_id: passId,
      text: 'sk-secret',
    });
    expect(blockedPass.ok).toBe(false);
    expect(blockedPass.requiresApproval).toBe(true);

    // javascript: link activation blocked
    const blockedLink = await executePageInteraction(doc, { action: 'click', node_id: badLinkId });
    expect(blockedLink.ok).toBe(false);
    expect(blockedLink.error).toMatch(/javascript:/i);

    // Submit gated via approval callback
    const approvalFn = vi.fn().mockResolvedValue(false);
    const deniedSubmit = await executePageInteraction(
      doc,
      { action: 'click', node_id: submitId },
      { onApprovalRequired: approvalFn },
    );
    expect(approvalFn).toHaveBeenCalledTimes(1);
    expect(deniedSubmit.ok).toBe(false);
    expect(deniedSubmit.requiresApproval).toBe(true);

    // Unknown node_id fails cleanly
    const missing = await executePageInteraction(doc, { action: 'click', node_id: 999 });
    expect(missing.ok).toBe(false);
  });
});
