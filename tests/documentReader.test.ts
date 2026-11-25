import { describe, expect, it, vi } from 'vitest';
import { readDocument } from '../src/documents/documentReader.js';

describe('Local Document Parser (read_document)', () => {
  it('extracts Markdown, HTML, CSV, and JSON locally offline', async () => {
    const mdRes = await readDocument({
      source: '# Architecture\n\nLocal WebGPU runtime.\n\n## Security\n\nZero network by default.',
      filename: 'design.md',
      query: 'WebGPU',
    });
    expect(mdRes.ok).toBe(true);
    expect(mdRes.result?.metadata.format).toBe('markdown');
    expect(mdRes.result?.content).toContain('WebGPU');

    const csvRes = await readDocument({
      source: 'model,params,vram\nPragma-2B,2B,1.4GB\nPragma-4B,4B,2.6GB',
      filename: 'models.csv',
    });
    expect(csvRes.ok).toBe(true);
    expect(csvRes.result?.metadata.format).toBe('csv');
    expect(csvRes.result?.metadata.columns).toEqual(['model', 'params', 'vram']);
    expect(csvRes.result?.metadata.rowCount).toBe(2);
    expect(csvRes.result?.content).toContain('| Pragma-4B | 4B | 2.6GB |');

    const htmlRes = await readDocument({
      source: '<html><head><title>Spec</title></head><body><main><h1>Hello</h1><p>Offline doc</p></main></body></html>',
    });
    expect(htmlRes.ok).toBe(true);
    expect(htmlRes.result?.metadata.format).toBe('html');
    expect(htmlRes.result?.metadata.title).toBe('Spec');
  });

  it('extracts built-in uncompressed PDF streams and supports page_range slicing', async () => {
    const syntheticPdf = [
      '%PDF-1.4',
      '<< /Title (Pragma Paper) /Author (Yours Research) >>',
      'BT /F1 12 Tf (Page one explains local WGSL kernels.) Tj ET',
      'BT /F1 12 Tf [(Page two covers ) -10 (AOM compression.)] TJ ET',
      '%%EOF',
    ].join('\n');

    const pdfRes = await readDocument({
      source: syntheticPdf,
      filename: 'pragma.pdf',
      page_range: '2',
    });
    expect(pdfRes.ok).toBe(true);
    expect(pdfRes.result?.metadata.format).toBe('pdf');
    expect(pdfRes.result?.metadata.title).toBe('Pragma Paper');
    expect(pdfRes.result?.metadata.author).toBe('Yours Research');
    expect(pdfRes.result?.metadata.pageCount).toBe(2);
    expect(pdfRes.result?.pages).toHaveLength(1);
    expect(pdfRes.result?.content).toContain('AOM compression.');
  });

  it('delegates binary PDFs to pluggable PdfBinaryExtractor (Offscreen/Worker)', async () => {
    const extractPdf = vi.fn().mockResolvedValue({
      title: 'Binary Report',
      pages: [
        { pageNumber: 1, text: 'Executive Summary' },
        { pageNumber: 2, text: 'Quarterly Revenue: $42M' },
      ],
    });

    const res = await readDocument(
      {
        source: 'data:application/pdf;base64,JVBERi0xLjQK',
        query: 'Revenue',
      },
      { pdfExtractor: { extractPdf } },
    );

    expect(extractPdf).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.result?.metadata.title).toBe('Binary Report');
    expect(res.result?.content).toContain('$42M');
  });
});
