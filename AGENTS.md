# AGENTS.md

This repository is now the accelerator research fork of ContextLab Mapper. Treat [voicesofhim/mapper](https://github.com/voicesofhim/mapper) as the primary remote/repo.

For a full implementation handoff, read:

```text
AGENT_HANDOFF.md
```

## Current Mission

Build Knowledge Mapper as an accelerator participant research tool:

- Interactive semantic map of anonymized participant evidence.
- Ask-the-Map grounded answers with highlighted source chunks.
- Evidence panel for interviews, prior interviews, social posts, mentor notes, program material, and reflections.
- Local Turso/libSQL as the canonical database.
- Static Mapper-compatible JSON as the current frontend delivery format.
- Local EmbeddingGemma as the production embedding provider.
- Future LiveKit integration should stay local-only for this phase.

## Important Context

This is no longer primarily the original Wikipedia/Khan Academy educational app. Legacy Mapper files are still present and should be preserved when useful, but new work should follow the accelerator research direction.

## Key Files

```text
README.md
AGENT_HANDOFF.md
scripts/accelerator-schema.sql
scripts/embed_embeddinggemma.py
scripts/import_accelerator_dataset.mjs
scripts/export_accelerator_domain.mjs
data/domains/index.json
data/domains/all.json
data/domains/accelerator-demo.json
data/domains/accelerator-seed.json
src/app.js
src/ui/quiz.js
src/ui/video-panel.js
src/viz/renderer.js
tests/accelerator/
tests/visual/accelerator-observatory.spec.js
```

## Safety Rules

- Never commit raw transcripts or private source data.
- Never commit API keys, `.env*`, `.credentials/`, screenshots with sensitive data, or local logs.
- Keep vector blobs out of frontend JSON.
- Preserve `consent_level`, `visibility`, and `anonymization_level`.
- Treat profile/personality fields as research inferences, not diagnoses.
- Distinguish source evidence from synthesized claims.
- If you see a secret in chat or terminal history, do not repeat it. Ask the owner to rotate it.

## Commands

```bash
npm install
npm run dev
npm run import:accelerator
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-model google/embeddinggemma-300M
npm test
npm run build
npm run test:accelerator:visual -- --project=chromium
```

## Embedding Direction

Current implementation:

- `local` provider: deterministic hash embeddings for fixture/test generation.
- `embeddinggemma` provider: local Google EmbeddingGemma through `scripts/embed_embeddinggemma.py`.
- `openai` provider: optional experimental path from earlier exploration; not preferred.

Local model setup:

```bash
npm run setup:embeddinggemma
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-model google/embeddinggemma-300M --embedding-model-path models/embeddinggemma-300m --embedding-command .venv-embeddinggemma/bin/python
```

Keep this local-first:

- Store vectors in local Turso/libSQL `embeddings.embedding_vector`.
- Compute UMAP outside the browser.
- Export static Mapper JSON without vector blobs.
- Keep future LiveKit agent/backend local-only until the project explicitly changes that requirement.

Relevant Google docs:

- https://ai.google.dev/gemma/docs/embeddinggemma
- https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers
