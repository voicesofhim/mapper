# Knowledge Mapper: Accelerator Observatory

Fork-based adaptation of [ContextLab Mapper](https://github.com/ContextLab/mapper) for accelerator participant research. This repo now targets [voicesofhim/mapper](https://github.com/voicesofhim/mapper) as the primary project.

The app keeps useful parts of Mapper's original architecture: static domain bundles, domain registry/loading, canvas map rendering, viewport transitions, panel layout, and test scaffolding. The education quiz/Khan Academy experience has been reinterpreted as an accelerator interview intelligence tool: an interactive semantic map of anonymized participant evidence, themes, source signals, and grounded Ask-the-Map responses.

## Current Status

Implemented and pushed to `main`:

- Accelerator research domain model in `data/domains/*.json`.
- Luminous semantic-observatory canvas styling for evidence nodes.
- Ask-the-Map panel replacing the original quiz flow.
- Evidence / Supporting Signals panel replacing lecture/video recommendations.
- Participant, source type, theme, and color-by map lenses.
- Future voice-agent map actions through `window.mapperActions` and `mapper:action` events.
- Canonical Turso/libSQL schema in `scripts/accelerator-schema.sql`.
- Import pipeline for anonymized interview markdown.
- Local Google EmbeddingGemma provider via a Python/Sentence Transformers sidecar.
- Seed domain generated from 3 anonymized fixture interviews.
- Static Mapper JSON export plus Turso seed SQL.
- Tests for schema, importer, exporter, no-browser-UMAP, and visual behavior.

Important caveat: the repository still contains some legacy ContextLab Mapper files and tests. They are intentionally preserved where useful, but the primary product direction is now accelerator research.

## Run Locally

```bash
npm install
npm run dev
```

Open:

```text
http://127.0.0.1:5173/mapper/
```

If Vite chooses another port, use the URL printed by the terminal.

Production build:

```bash
npm run build
npm run preview
```

## Useful Commands

```bash
# App
npm run dev
npm run build
npm run preview

# Accelerator import/export pipeline
npm run import:accelerator

# Tests
npm test
npm run test:accelerator:visual -- --project=chromium
npm run test:legacy
```

`npm test` runs the accelerator/unit suite. `npm run test:legacy` preserves original Mapper algorithm tests that may still contain Wikipedia/Khan assumptions.

## Repository Map

```text
.
├── data/
│   ├── accelerator/
│   │   ├── raw/anonymized-interviews/       # Seed anonymized markdown inputs
│   │   └── exports/
│   │       ├── accelerator-seed.json        # Generated Mapper-compatible export
│   │       └── accelerator-seed.sql         # Generated Turso/libSQL seed inserts
│   ├── domains/
│   │   ├── all.json                         # Synthetic accelerator demo bundle
│   │   ├── accelerator-demo.json            # Focused synthetic demo bundle
│   │   ├── accelerator-seed.json            # Generated seed interview domain
│   │   └── index.json                       # Static domain registry
│   └── videos/                              # Legacy Mapper video assets
├── scripts/
│   ├── accelerator-schema.sql               # Canonical Turso/libSQL schema
│   ├── embed_embeddinggemma.py              # Local EmbeddingGemma sidecar
│   ├── import_accelerator_dataset.mjs       # Markdown -> chunks -> embeddings -> UMAP -> JSON/SQL
│   └── export_accelerator_domain.mjs        # Turso/static export normalizer
├── src/
│   ├── app.js                               # Main wiring, accelerator mode, map actions
│   ├── domain/loader.js                     # Domain bundle normalization/caching
│   ├── ui/quiz.js                           # Ask-the-Map UI
│   ├── ui/video-panel.js                    # Evidence panel
│   └── viz/renderer.js                      # Canvas renderer and luminous node styling
├── tests/
│   ├── accelerator/                         # Schema/import/export contract tests
│   └── visual/accelerator-observatory.spec.js
└── AGENT_HANDOFF.md                         # Read this before continuing implementation
```

## Product Model

The app maps accelerator research evidence, not educational content.

Supported source types:

- `interview`
- `prior_interview`
- `social`
- `mentor_note`
- `program_material`
- `reflection`

Participants support:

- `id`
- `display_code`
- `role`
- `company_stage`
- `cohort`
- `profile_json`
- `consent_level`
- `visibility`
- `anonymization_level`

Map items / chunks support:

- `id`
- `participant_id`
- `source_type`
- `title`
- `summary`
- `excerpt` / `anonymized_text`
- `themes[]`
- `sentiment`
- `confidence`
- `umap_x` / `x`
- `umap_y` / `y`
- `metadata_json`
- `source`
- `embedding_metadata`
- `projection`
- `consent_level`
- `visibility`

UMAP coordinates are always precomputed by the import/export pipeline. The browser loads and renders coordinates; it does not recompute UMAP.

## Canonical Turso/libSQL Schema

Apply or mirror:

```text
scripts/accelerator-schema.sql
```

It defines:

- `participants`: display code, cohort, company stage, inferred profile JSON, consent, visibility.
- `sources`: source type, source refs, raw-text policy, consent, metadata.
- `chunks`: anonymized evidence excerpts and summaries.
- `themes` and `chunk_themes`: normalized theme catalog and per-chunk confidence.
- `embeddings`: provider, model, dimensions, vector BLOB, vector hash, input hash.
- `umap_coordinates`: precomputed 2D projection coordinates linked to an embedding.
- `research_questions` and `question_evidence`: grounded Ask-the-Map responses and supporting chunks.

The frontend should not connect directly to Turso for the current Mapper-compatible build. Turso/libSQL is the canonical backend, but for this phase it should be run locally only; static JSON remains the browser delivery format.

## Import Pipeline

Place anonymized inputs in:

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
source_id: source-p-001-interview
source_type: interview
source_ref: local-anonymized/p-001.md
consent_level: anonymized_research
visibility: researcher
anonymization_level: strict
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

The importer currently:

1. Parses anonymized markdown.
2. Creates participant and source records.
3. Chunks text into evidence items.
4. Assigns initial themes with deterministic rules.
5. Generates embeddings.
6. Computes UMAP coordinates in Node.
7. Writes static Mapper JSON.
8. Writes Turso/libSQL seed SQL.

Outputs:

- `data/accelerator/exports/accelerator-seed.json`
- `data/accelerator/exports/accelerator-seed.sql`
- `data/domains/accelerator-seed.json`

## Embedding Pipeline

The importer has three provider paths:

- `local`: deterministic hash embeddings for tests and offline fixture generation.
- `embeddinggemma`: local Google EmbeddingGemma embeddings through `scripts/embed_embeddinggemma.py`.
- `openai`: optional legacy/experimental path from earlier exploration; not the preferred direction.

The intended production path is **local Google EmbeddingGemma**, not OpenAI.

Provider details:

- Provider name: `embeddinggemma`
- Model: `google/embeddinggemma-300M` / `google/embeddinggemma-300m`
- Runtime: local Python sidecar using Sentence Transformers.
- Output: float vectors stored as Turso/libSQL BLOBs in `embeddings.embedding_vector`.
- Metadata: provider, model id, dimensions, vector hash, input hash.
- UMAP: computed in Node or Python after embeddings are generated.
- Frontend JSON: should include only embedding metadata and UMAP coordinates, not vector blobs.

Set up the local model environment:

```bash
npm run setup:embeddinggemma
```

This creates `.venv-embeddinggemma`, installs the Hugging Face `hf` CLI and Sentence Transformers dependencies, checks local Hugging Face auth, and downloads the model into ignored `models/embeddinggemma-300m/`. If needed, first accept the Gemma license on Hugging Face, then run `hf auth login` or set `HF_TOKEN` in your local shell. Do not commit that token.

Then run the importer with the local provider:

```bash
npm run import:accelerator -- \
  --embedding-provider embeddinggemma \
  --embedding-model models/embeddinggemma-300m \
  --embedding-command .venv-embeddinggemma/bin/python \
  --embedding-dimensions 768
```

Useful optional flags:

```bash
# Apple Silicon
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-device mps

# Smaller Matryoshka vector for local experiments
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-dimensions 256

# Custom Python executable or sidecar
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-command .venv-embeddinggemma/bin/python
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-script scripts/embed_embeddinggemma.py

# Install deps/auth only, without downloading the model
npm run setup:embeddinggemma -- --skip-download
```

The setup script uses the Hugging Face CLI documented as `hf auth login` and `hf download`. Model files live under `models/`, which is ignored by git.

Google describes EmbeddingGemma as a 308M-parameter local/on-device embedding model with 768-dimensional embeddings, flexible output dimensions down to 128 via Matryoshka Representation Learning, and offline operation. See:

- [EmbeddingGemma overview](https://ai.google.dev/gemma/docs/embeddinggemma)
- [EmbeddingGemma with Sentence Transformers](https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers)

## Ask-The-Map

Ask-the-Map currently uses grounded sample questions from domain JSON:

```json
{
  "ask_map": {
    "questions": [
      {
        "id": "ask-seed-autonomy-mentorship",
        "query": "Where does mentorship help without reducing autonomy?",
        "answer": {
          "synthesis": "Inference: ...",
          "supporting_evidence": ["..."],
          "participant_codes": ["P-101"],
          "highlighted_map_item_ids": ["..."],
          "themes": ["self-direction"],
          "suggested_follow_up": "..."
        }
      }
    ]
  }
}
```

It does not pretend to be a full AI answer engine yet. It matches known questions/aliases and highlights evidence IDs. The future backend should search Turso/embeddings, generate a grounded answer, and send map actions back to the frontend.

## Future LiveKit / Voice-Agent Hooks

LiveKit is not implemented yet. When it is added, it should be local-only for this phase, with a local agent/backend reading from local Turso/libSQL and emitting frontend map actions.

The app exposes:

```js
window.mapperActions.highlightMapItems(itemIds, reason)
window.mapperActions.showEvidencePanel(items)
window.mapperActions.setMapLens({ theme, colorBy, highlightedIds })
window.mapperActions.clearMapLens()
window.mapperActions.selectParticipant(participantId)
```

It also listens for:

```js
window.dispatchEvent(new CustomEvent('mapper:action', {
  detail: {
    type: 'highlightMapItems',
    payload: { itemIds, reason, focus: true }
  }
}))
```

Expected future flow:

1. Researcher/participant speaks.
2. LiveKit agent transcribes/responds.
3. Backend searches Turso chunks and embedding vectors.
4. Agent returns answer plus map actions.
5. Frontend highlights nodes and opens evidence.

## Privacy And Governance

This project handles sensitive human research data. Keep these rules:

- Do not commit raw transcripts.
- Prefer anonymized excerpts.
- Preserve `consent_level`, `visibility`, and `anonymization_level`.
- Keep vector blobs out of frontend JSON.
- Distinguish source evidence from synthesized claims.
- Label profile/personality statements as inferences, not diagnoses.
- Participant-facing mode should be more careful and reflective than researcher mode.
- `.env`, `.env.*`, `.credentials/`, screenshots, and generated artifacts likely to contain sensitive content are ignored.

Important: an OpenAI API key was pasted into chat during development. It was not written to repo files, and a repo scan did not find it. The key should still be rotated/revoked because chat transcripts are not a safe secret store.

## Validation

Current validation commands:

```bash
npm test
npm run build
npm run test:accelerator:visual -- --project=chromium
rm -f /tmp/accelerator-seed.sqlite \
  && sqlite3 /tmp/accelerator-seed.sqlite < scripts/accelerator-schema.sql \
  && sqlite3 /tmp/accelerator-seed.sqlite < data/accelerator/exports/accelerator-seed.sql \
  && sqlite3 /tmp/accelerator-seed.sqlite "select count(*), count(embedding_vector), min(length(embedding_vector)), max(length(embedding_vector)) from embeddings;"
```

Expected sqlite check for the local seed fixture:

```text
7|7|384|384
```

That means 7 embedding rows, 7 stored vector blobs, each 384 bytes in the local 96-dimensional float32 fixture mode.

## Next Priorities

1. Run the real EmbeddingGemma sidecar on approved anonymized seed inputs and review the resulting map.
2. Support mixed-source ingestion through manifests, not just interview markdown.
3. Replace seed fixtures with the first approved anonymized participant exports.
4. Add real semantic Ask-the-Map retrieval over local Turso chunks/vectors.
5. Add researcher vs participant-facing mode.
6. Add the future LiveKit bridge as local-only.
7. Add CI checks for import/export contract and no-secret scanning.
