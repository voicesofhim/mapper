# Knowledge Mapper: Accelerator Observatory

Fork-based adaptation of [ContextLab Mapper](https://github.com/ContextLab/mapper) for accelerator participant research. This version keeps Mapper's static domain registry, domain-bundle loader, canvas map renderer, viewport handling, and panel architecture, but replaces the education quiz/video domain with a grounded interview-intelligence experience.

## Run Locally

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:5173/mapper/](http://127.0.0.1:5173/mapper/).

Production build:

```bash
npm run build
npm run preview
```

## What Changed

- `data/domains/all.json` is now a synthetic accelerator research bundle.
- `data/domains/accelerator-demo.json` provides the focused demo domain.
- `data/domains/accelerator-seed.json` is generated from 3 anonymized seed interview files via the canonical import pipeline.
- `scripts/accelerator-schema.sql` defines the Turso/libSQL source-of-truth schema.
- `scripts/import_accelerator_dataset.mjs` imports anonymized interviews, chunks them, generates embeddings, computes UMAP outside the browser, and writes Mapper JSON plus seed SQL.
- `src/ui/quiz.js` preserves the original panel contract but now renders Ask the Map.
- `src/ui/video-panel.js` is reinterpreted as Evidence / Supporting Signals.
- `src/viz/renderer.js` renders luminous evidence nodes, glow halos, selected rings, highlighted pulse states, and faint participant paths.
- `src/app.js` maps accelerator data into Mapper's existing loader/rendering flow and exposes future voice-agent map actions.
- The map includes lenses for participant, source type, theme, and color-by modes for source, theme, and profile traits.

## Accelerator Data Model

Turso/libSQL is the canonical source of truth. Static domain JSON is a compatibility export for Mapper's existing loader. Important frontend fields:

- `participants[]`: `id`, `display_code`, `role`, `company_stage`, `cohort`, `profile_json`, `consent_level`, `visibility`, and `anonymization_level`.
- `map_items[]`: evidence chunks with `id`, `participant_id`, `source_type`, `title`, `summary`, `excerpt` / `anonymized_text`, `themes[]`, `sentiment`, `confidence`, `umap_x` / `x`, `umap_y` / `y`, `metadata_json`, `source`, `embedding_metadata`, `projection`, `consent_level`, and `visibility`.
- `ask_map.questions[]`: grounded sample prompts, answer syntheses, participant codes, highlighted map item IDs, themes, and follow-up questions.

UMAP coordinates are precomputed. The browser loads and displays them; it does not recompute UMAP.

## Canonical Turso Schema

Apply or mirror `scripts/accelerator-schema.sql`. It defines:

- `participants`: participant display code, cohort, company stage, profile inference JSON, consent, visibility, anonymization level.
- `sources`: interview/social/mentor/program/reflection records, source refs, raw-text policy, consent, metadata.
- `chunks`: anonymized evidence excerpts and summaries linked to participant/source.
- `themes` and `chunk_themes`: normalized theme catalog and per-chunk confidence.
- `embeddings`: embedding provider/model/dimensions/vector hash and optional vector blob.
- `umap_coordinates`: precomputed 2D projection coordinates linked to an embedding.
- `research_questions` and `question_evidence`: grounded Ask-the-Map responses and supporting chunks.

## Import And Export Pipeline

Place 2-3 anonymized interview files in:

```text
data/accelerator/raw/anonymized-interviews/
```

Each file supports simple frontmatter:

```md
---
participant_id: p-001
display_code: P-001
role: technical founder
company_stage: prototype
cohort: spring-2026
source_type: interview
consent_level: anonymized_research
visibility: researcher
openness: 0.72
conscientiousness: 0.64
ambiguityComfort: 0.81
trustInMentorship: 0.45
publicPrivateTension: 0.66
---

Anonymized interview excerpt text...
```

Run:

```bash
npm run import:accelerator
```

The importer writes:

- `data/accelerator/exports/accelerator-seed.json`: generated Mapper-compatible export.
- `data/accelerator/exports/accelerator-seed.sql`: Turso/libSQL seed inserts.
- `data/domains/accelerator-seed.json`: static domain loaded by the frontend.

The current importer uses deterministic local hash embeddings for safe pipeline validation and `umap-js` to compute UMAP coordinates outside the browser. For production, replace the embedding function with the chosen embedding provider, keep the same `embeddings` and `umap_coordinates` records, and export static JSON from Turso.

Use Turso/libSQL as the canonical store, then export static JSON for Mapper:

1. Query participants, sources, chunks/map items, themes, embeddings metadata, UMAP coordinates, and consent fields.
2. Join chunk theme labels and source metadata.
3. Emit `map_items[]` with normalized `x` / `y` aliases for `umap_x` / `umap_y`.
4. Emit `participants[]` and optional `ask_map.questions[]`.
5. Write `data/domains/all.json`, one or more focused domain files, and `data/domains/index.json`.

The frontend expects JSON bundles, so the export can be generated in CI or by an admin pipeline without changing the app.

## Future LiveKit Hook

The app exposes:

```js
window.mapperActions.highlightMapItems(itemIds, reason)
window.mapperActions.showEvidencePanel(items)
window.mapperActions.setMapLens({ theme, colorBy, highlightedIds })
window.mapperActions.clearMapLens()
window.mapperActions.selectParticipant(participantId)
```

It also listens for `mapper:action` events. A LiveKit voice agent can transcribe a question, search Turso/embeddings on the backend, then send one of these actions to the frontend to update highlights and evidence.

## Privacy Notes

The checked-in seed interviews are anonymized fixtures for pipeline validation, not private raw transcripts. Production exports should prefer anonymized excerpts, preserve `consent_level`, respect `visibility`, distinguish source evidence from synthesized claims, and label personality/profile interpretations as inferences rather than diagnoses.

## Validation

Useful commands:

```bash
npm run build
npm test
npm run import:accelerator
npm run test:accelerator:visual -- --project=chromium
npm run test:legacy
```

`npm test` runs the accelerator contract/unit suite. `npm run test:legacy` preserves the original Mapper algorithm tests, which still contain 50-domain Wikipedia/Khan Academy assumptions and video-pipeline performance checks.

Browser smoke screenshots are saved in `screenshots/`.

## TODO

- Replace the seed fixtures with the first approved anonymized participant interview exports.
- Add researcher vs participant-facing detail modes.
- Update or split tests so legacy Mapper tests and accelerator tests can run independently.
- Connect real backend search and LiveKit agent events.
- Add richer filters for participant, source type, theme, and profile-trait lensing.
