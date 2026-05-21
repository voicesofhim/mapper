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
- `src/ui/quiz.js` preserves the original panel contract but now renders Ask the Map.
- `src/ui/video-panel.js` is reinterpreted as Evidence / Supporting Signals.
- `src/viz/renderer.js` renders luminous evidence nodes, glow halos, selected rings, highlighted pulse states, and faint participant paths.
- `src/app.js` maps accelerator data into Mapper's existing loader/rendering flow and exposes future voice-agent map actions.
- The map includes lenses for participant, source type, theme, and color-by modes for source, theme, and profile traits.

## Accelerator Data Model

The static domain JSON is a compatibility export that can be generated from Turso/libSQL. Important fields:

- `participants[]`: `id`, `display_code`, `role`, `company_stage`, `cohort`, and `profile_json`.
- `map_items[]`: evidence chunks with `id`, `participant_id`, `source_type`, `title`, `summary`, `excerpt` / `anonymized_text`, `themes[]`, `sentiment`, `confidence`, `umap_x` / `x`, `umap_y` / `y`, `metadata_json`, `source`, and `consent_level`.
- `ask_map.questions[]`: grounded sample prompts, answer syntheses, participant codes, highlighted map item IDs, themes, and follow-up questions.

UMAP coordinates are precomputed. The browser loads and displays them; it does not recompute UMAP.

## Turso Export Shape

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

This demo uses synthetic data only. Production exports should prefer anonymized excerpts, preserve `consent_level`, distinguish source evidence from synthesized claims, and label personality/profile interpretations as inferences rather than diagnoses.

## Validation

Useful commands:

```bash
npm run build
npm test
npm run test:accelerator:visual -- --project=chromium
npm run test:legacy
```

`npm test` runs the accelerator contract/unit suite. `npm run test:legacy` preserves the original Mapper algorithm tests, which still contain 50-domain Wikipedia/Khan Academy assumptions and video-pipeline performance checks.

Browser smoke screenshots are saved in `screenshots/`.

## TODO

- Replace synthetic evidence with a Turso export pipeline.
- Add researcher vs participant-facing detail modes.
- Update or split tests so legacy Mapper tests and accelerator tests can run independently.
- Connect real backend search and LiveKit agent events.
- Add richer filters for participant, source type, theme, and profile-trait lensing.
