# Implementation Plan: Analytics & Response Data Collection

**Branch**: `010-analytics-data-collection` | **Date**: 2026-03-21 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/010-analytics-data-collection/spec.md`

## Summary

Add visitor analytics (GoatCounter snippet) and anonymized response data collection (token encoding → Google Apps Script → Google Sheet) to the Knowledge Mapper. Includes a tutorial consent step ("Contribute to science!"), an About modal opt-out toggle, and an offline token decoder script. All changes are feature-flagged and must not affect the live site until explicitly signed off.

## Technical Context

**Language/Version**: JavaScript ES2022+ (ES modules), HTML5, CSS3
**Primary Dependencies**: nanostores 1.1, Vite 7.3, pako (existing — for token deflate), GoatCounter (external CDN script)
**Storage**: localStorage (opt-out preference), Google Sheets (collection records via GAS)
**Testing**: Vitest (unit), Playwright (E2E)
**Target Platform**: Static web app on GitHub Pages, all modern browsers
**Project Type**: Web application (client-side SPA)
**Performance Goals**: Collection must add no perceptible delay to quiz flow
**Constraints**: No changes to main without sign-off; no PII in collected data; no cookies
**Scale/Scope**: ~1000 daily users initially, ~10K requests/day to GAS endpoint

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

- **Principle I (Accuracy)**: ✅ No new data content or questions. Token codec reuse preserves encoding fidelity. Decoder script enables round-trip verification.
- **Principle II (User Delight)**: ✅ No visible UI changes except opt-out toggle in About modal and consent step in tutorial. Collection is silent and non-blocking. Must verify tutorial step visually via Playwright.
- **Principle III (Compatibility)**: ✅ GoatCounter script is async and lightweight. `fetch()` with `no-cors` is universally supported. localStorage is already used throughout. Must test on mobile viewports.

No violations. No complexity tracking needed.

## Project Structure

### Documentation (this feature)

```text
specs/010-analytics-data-collection/
├── plan.md              # This file
├── research.md          # Phase 0: technology decisions
├── data-model.md        # Phase 1: entities and data flow
├── quickstart.md        # Phase 1: setup guide
├── contracts/
│   └── gas-endpoint.md  # Phase 1: GAS endpoint contract
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── collection/
│   └── collector.js     # NEW: response collection module (config, send logic, interval tracking)
├── ui/
│   ├── tutorial.js      # MODIFIED: add consent step (ID 15) before completion step
│   └── about.js         # NEW or MODIFIED: opt-out toggle + disclosure text in About modal
├── app.js               # MODIFIED: wire collector to handleAnswer, pass questionIndex
└── sharing/
    └── token-codec.js   # UNCHANGED: reused by collector

scripts/
└── decode-tokens.js     # NEW: offline decoder for Google Sheet tokens → CSV/JSON

index.html               # MODIFIED: GoatCounter snippet, About modal disclosure section

tests/
├── unit/
│   └── collector.test.js  # NEW: unit tests for collection logic
└── visual/
    └── collection-flow.spec.js  # NEW: E2E test for tutorial consent + About toggle
```

**Structure Decision**: New `src/collection/` directory for the collector module, keeping it isolated from existing code. The collector imports from `src/sharing/token-codec.js` (existing). Tutorial and About modal changes are minimal modifications to existing files.
