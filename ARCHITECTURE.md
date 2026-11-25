# Architecture — `@yours/tools`

`@yours/tools` is designed as a **zero-runtime-dependency, environment-agnostic TypeScript SDK** that provides identical Schema v1.1 tool semantics across **Chromium Manifest V3 extensions** and **`yours.sh` embedded web demos**.

## Design Principles

1. **Zero External Network by Default:** All extraction, AOM snapshotting, DOM interactions, document parsing, and sandbox compute operate 100% locally. Network tools (`search_web_tab`, `fetch_background_tab`) explicitly set `safety.networkHint = true` and fail closed unless host permission or explicit policy approval is granted.
2. **Self-Contained MV3 Injection Safety:** `inPageExtractScript`, `inPageSemanticExtractScript`, and `inPageInteractScript` never reference outer-scope imports or closures so `chrome.scripting.executeScript({ func })` serializes them cleanly without bundler surprises.
3. **Dual-Environment Parity (`ToolHostAdapter`):** Both `ChromeExtensionAdapter` and `WebDemoAdapter` implement the exact same `ToolHostAdapter` interface and run through `ToolRuntime`, ensuring uniform `ToolExecutionResult` shapes, `tainted` provenance flags, and `sourceOrigin` metadata.
4. **CSP-Safe Air-Gapped Compute:** `run_sandbox` never invokes `eval()`, `new Function()`, or dynamic `import()`. It executes deterministic math/unit/date/JSON/CSV operations and an AST-isolated JS subset with step/timeout and memory ceilings, or delegates to an optional `QuickJsRuntimeAdapter` (QuickJS-WASM).

## Directory Layout

```text
src/
├── types.ts                  # Shared Ecosystem Contracts v1.0 & Tool Schema v1.1 types
├── index.ts                  # Public barrel exports
├── schemas/
│   ├── registry.ts           # Canonical 10-tool registry + ToolSafetyHints
│   ├── aliases.ts            # Legacy alias resolution & parameter normalization
│   └── exporters.ts          # OpenAI, Qwen, Pragma JSON-Schema & prompt exporters
├── extractors/
│   ├── semanticAom.ts        # Compact AOM snapshotter (Shadow DOM, landmarks, forms, tables)
│   ├── pageExtractor.ts      # Unified document & MV3 script extractor (auto/selection/YT/PDF/AOM)
│   └── htmlDistiller.ts      # HTML-to-Markdown distiller & YouTube transcript XML parser
├── actions/
│   └── interactPage.ts       # Bounded click/type/select/check/scroll with settled DOM diffing
├── documents/
│   └── documentReader.ts     # Offline PDF/Markdown/HTML/CSV/JSON/TXT parser for Offscreen/Worker
├── sandbox/
│   └── sandbox.ts            # Air-gapped compute & transform sandbox (+ QuickJS-WASM hook)
├── search/
│   ├── bm25Ranker.ts         # Chunked BM25 passage ranker
│   ├── webSearch.ts          # SERP parsers (DDG, Bing, Startpage) & anti-bot CAPTCHA detector
│   └── urlFetcher.ts         # Parallel URL fetcher with fail-closed permission gating
├── protocol/
│   └── toolParser.ts         # Resilient <tool_call> / Qwen XML / OpenAI parser + JSON repair
└── adapters/
    ├── types.ts              # ToolHostAdapter, ToolRuntime, InMemoryMemoryProvider
    ├── chromeExtensionAdapter.ts  # Chromium MV3 adapter (tabs, scripting, offscreen, permissions)
    └── webDemoAdapter.ts     # Virtual tab / iframe / JSDOM adapter for yours.sh demos
```

## Security & Taint Propagation

Every `ToolExecutionResult` carries `tainted: boolean` and optional `sourceOrigin`:
- **Untrusted DOM / Web / Document outputs** (`read_active_tab`, `read_tab`, `interact_page`, `read_document`, `search_web_tab`, `fetch_background_tab`, `list_tabs`) set `tainted: true` so `@yours/guard` can spotlight untrusted text and prevent indirect prompt injection (IDPI).
- **Pure local compute** (`run_sandbox`) sets `tainted: false`.
- **Memory tools** (`memory_recall`, `memory_save`) propagate taint if any recalled `MemoryRecord` is marked `tainted: true`.
- **Anti-bot & CAPTCHA gates:** `webSearch` and `urlFetcher` detect anti-bot/CAPTCHA interstitials and return `{ ok: false, blockedByCaptcha: true, manualUrl }` without ever attempting to bypass them.
