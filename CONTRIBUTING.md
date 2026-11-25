# Contributing to `@yours/tools`

Thank you for contributing to **Yours Research**! `@yours/tools` is licensed under **Apache-2.0**.

## Development Setup

Requirements:
- Node.js `>= 20.0.0`
- npm `>= 10`

```bash
git clone https://github.com/yours-research/yours-tools.git
cd yours-tools
npm install
```

## Verification Commands

Every pull request must pass all three checks with zero errors:

```bash
npm run typecheck
npm run build
npm test
```

## Coding & Contract Guidelines

1. **Follow `docs/ECOSYSTEM_CONTRACTS.md`:** Never break `CanonicalToolName`, `ToolSafetyHints`, `ToolDefinition`, `ToolInvocationContext`, or `ToolExecutionResult` without a coordinated cross-repo contract update.
2. **Zero Runtime Dependencies:** Keep `dependencies` empty in `package.json` so `@yours/tools` remains lightweight and directly bundleable in Chrome MV3 service workers, Offscreen Documents, Web Workers, and `yours.sh` demos.
3. **MV3 Script Isolation:** Any function passed to `chrome.scripting.executeScript({ func })` (`inPageExtractScript`, `inPageSemanticExtractScript`, `inPageInteractScript`) must be 100% self-contained with zero references to outer-scope helpers.
4. **Fail-Closed Privacy & Security:** Network capabilities must remain disabled by default and gated behind explicit permission/policy checks. Sandbox evaluators must never use `eval()`, `new Function()`, or expose host globals.
5. **Dual-Adapter Parity:** Any new tool feature or parameter must work identically in both `ChromeExtensionAdapter` and `WebDemoAdapter`, verified by tests in `tests/adaptersParity.test.ts`.
