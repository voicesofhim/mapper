# Agent Handoff: Knowledge Mapper Accelerator Observatory

Last updated: 2026-05-22

Primary repo: `voicesofhim/mapper`

Working directory used in this session:

```text
/Users/ryanjames/Documents/New project/contextlab-mapper-accelerator
```

## Executive Summary

This repo began as a fork/adaptation of ContextLab Mapper. It is now the primary implementation path for an accelerator participant research tool called Knowledge Mapper / Accelerator Observatory.

The original education/quiz/Khan Academy domain has been reinterpreted as:

- a semantic evidence map of accelerator participant research;
- an Ask-the-Map interface for grounded research questions;
- an Evidence panel for excerpts and supporting signals;
- a local Turso/libSQL-backed canonical data model with static JSON export for the current frontend;
- a future local-only LiveKit voice-agent target through frontend map action hooks.

The app is functional with checked-in seed data and local-only private preview buckets. The importer includes a local Google EmbeddingGemma provider through a Python/Sentence Transformers sidecar, plus a deterministic local hash provider for tests and smoke previews. The first real-source adapter is `scripts/import_slab_dataset.mjs`; it imports the SLAB repo into ignored local bundles and Turso/libSQL seed SQL without committing generated evidence data. See `docs/EMBEDDING_PIPELINE.md` before changing ingestion, embeddings, tags, or dataset storage.

## What Has Been Done

### Repo / Git

- `voicesofhim/mapper` is now the primary origin.
- `main` contains the accelerator implementation.
- ContextLab upstream has been preserved locally as `upstream`.
- Recent important commits:
  - `b85daf7 Adapt Mapper for accelerator observatory`
  - `a6c9260 Tune Ask lens focus`
  - `621addb Add accelerator Turso import pipeline`
  - `ec0da29 Add OpenAI embedding provider pipeline`
  - `f37b745 Ignore local env files`

### Frontend Experience

Implemented:

- Dark "semantic observatory" visual style.
- Luminous particle-like map nodes.
- Additive canvas blending and glow halos.
- Selected/highlighted node rings.
- Subtle evidence-node pulse.
- Participant paths as faint light trails.
- Source-type colors:
  - interview: blue-white
  - prior interview: soft indigo
  - social: amber
  - mentor note: green
  - program material: pale gold
  - reflection: violet

Key files:

```text
src/viz/renderer.js
src/app.js
index.html
```

### Ask-The-Map

The original quiz UI has been adapted into Ask-the-Map.

Current behavior:

- Users ask/select sample research questions.
- The answer panel shows:
  - short synthesis;
  - supporting evidence;
  - participant codes;
  - themes;
  - suggested follow-up.
- Highlighted map nodes pulse subtly.
- Non-answer nodes dim.
- The map gently recenters with a capped focus lens.

Key file:

```text
src/ui/quiz.js
```

Open-ended local retrieval is available through a local-only server:

```bash
npm run ask:server
```

The frontend calls `http://127.0.0.1:8787/api/ask-map` when available. The server keeps a persistent local EmbeddingGemma worker warm, embeds the question with `Retrieval-query`, searches local libSQL/Turso vector BLOBs by cosine similarity, and returns evidence chunks plus map item IDs. If the server is unavailable, the frontend falls back to static sample answers.

### Evidence Panel

The original lecture/video panel has been reinterpreted as Evidence / Supporting Signals.

Current behavior:

- Shows interview excerpts, source metadata, participant codes, source type, themes.
- Clicking a node opens the evidence panel for that map item.
- Ask responses narrow the evidence list to supporting chunks.

Key file:

```text
src/ui/video-panel.js
```

### Map Lens / Filters

Implemented:

- Filter by participant.
- Filter by source type.
- Filter by theme.
- Color by:
  - source type;
  - theme;
  - openness;
  - conscientiousness;
  - ambiguity comfort;
  - mentorship trust;
  - public/private tension.

Key file:

```text
src/app.js
```

### Local LiveKit / STT Hooks

The frontend exposes:

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

The Ask panel also has `Chat` and `VOICE` modes. Voice mode mounts the official LiveKit Agents UI Aura visualizer block from `src/components/agents-ui/agent-audio-visualizer-aura.jsx`; do not replace it with a hand-rolled imitation unless the product direction changes. For the current milestone, voice is STT-only: the local process should transcribe the user's question and let the existing local Ask server do retrieval. There is no voice response/TTS requirement yet.

The local Ask server issues development tokens at:

```text
POST http://127.0.0.1:8787/api/livekit-token
```

Local defaults:

```text
LIVEKIT_URL=ws://127.0.0.1:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

The STT bridge is implemented in:

```text
scripts/livekit_stt_bridge.py
requirements-voice.txt
scripts/setup_voice_stt.sh
```

Run it after starting a local LiveKit server, `npm run ask:server`, and `npm run dev`:

```bash
npm run setup:voice
npm run voice:stt
```

`npm run setup:voice` installs `.venv-voice` and prefetches the default `base.en` faster-whisper model into the local Hugging Face cache. Use `npm run setup:voice -- --model small.en` and `npm run voice:stt -- --model small.en` if the project wants a larger local STT model.

Manual frontend test mode:

```bash
npm run voice:stt:stdin
```

That joins the same room and publishes each terminal line as if it were a final spoken transcript.

The local LiveKit STT process publishes final transcripts on the LiveKit data channel topic `mapper.transcript`:

```json
{ "text": "Which participants need structure before they can execute?", "final": true }
```

It also publishes status updates on `mapper.voice_status`:

```json
{ "state": "transcribing", "detail": "browser-participant", "local_only": true }
{ "state": "searching", "detail": "Which participants need structure?", "local_only": true }
```

The frontend routes final transcript text into the existing Ask-the-Map retrieval flow, then highlights nodes and updates evidence exactly like chat. Voice status events trigger the graph thinking animation while local transcription/retrieval is happening. The browser does not implement cloud STT.

Expected local-only flow:

1. User speaks.
2. Browser publishes microphone audio to local LiveKit.
3. Local STT bridge transcribes locally and publishes `mapper.transcript`.
4. Frontend sends the transcript to local Ask-the-Map retrieval.
5. Local backend searches local Turso/embeddings.
6. Frontend highlights nodes and updates evidence.

## Data Model

Canonical database schema:

```text
scripts/accelerator-schema.sql
```

Tables:

- `participants`
- `sources`
- `chunks`
- `themes`
- `chunk_themes`
- `embeddings`
- `umap_coordinates`
- `research_questions`
- `question_evidence`

Important governance fields:

- `consent_level`
- `visibility`
- `anonymization_level`
- `raw_text_allowed`
- `contains_sensitive_data`
- `redaction_notes`

Frontend JSON is a compatibility export. The browser should receive:

- anonymized text/excerpts;
- source metadata;
- theme labels;
- embedding metadata;
- UMAP coordinates.

The browser should not receive:

- raw transcripts by default;
- API keys;
- vector blobs;
- private source material beyond approved anonymized excerpts.

Current architecture note: Turso/libSQL should be local-only for this phase. Do not configure a remote Turso cloud database unless the project owner explicitly changes the governance requirement.

## Current Seed Data

Input fixtures:

```text
data/accelerator/raw/anonymized-interviews/p-seed-01.md
data/accelerator/raw/anonymized-interviews/p-seed-02.md
data/accelerator/raw/anonymized-interviews/p-seed-03.md
```

Generated outputs:

```text
data/accelerator/exports/accelerator-seed.json
data/accelerator/exports/accelerator-seed.sql
data/domains/accelerator-seed.json
```

The seed domain currently includes:

- 3 participants: `P-101`, `P-102`, `P-103`
- 3 interview sources
- 7 chunks/map items
- 7 embeddings
- 7 UMAP coordinates
- 3 grounded sample research questions

## Import Pipeline

Main script:

```text
scripts/import_accelerator_dataset.mjs
```

Current flow:

1. Read anonymized markdown from `data/accelerator/raw/anonymized-interviews/`.
2. Parse frontmatter into participant/source records.
3. Chunk anonymized text.
4. Infer seed themes with deterministic keyword rules.
5. Generate embedding records.
6. Compute UMAP coordinates outside the browser.
7. Generate `ask_map.questions[]`.
8. Normalize into Mapper-compatible domain JSON.
9. Write frontend-safe JSON.
10. Write Turso/libSQL seed SQL with vector BLOBs.

Run:

```bash
npm run import:accelerator
```

## Embedding Pipeline State

### What Exists Now

The importer currently supports:

- `local`: deterministic hash embeddings for offline fixtures and tests.
- `embeddinggemma`: local Google EmbeddingGemma through `scripts/embed_embeddinggemma.py`.
- `openai`: provider-backed path added during exploration.

The OpenAI path is not the intended production direction anymore. It should be considered optional/experimental or removed once it is no longer useful for contract tests.

### Production Direction

Use local Google EmbeddingGemma.

Local setup:

```bash
npm run setup:embeddinggemma
```

This creates `.venv-embeddinggemma`, installs `requirements-embeddinggemma.txt`, provides the Hugging Face `hf` CLI, checks auth with `hf auth whoami`, and downloads the model into ignored `models/embeddinggemma-300m/` using `hf download`. The developer may need to accept the Gemma license on Hugging Face before the download works.

Run the importer with the local provider:

```bash
npm run import:accelerator -- \
  --embedding-provider embeddinggemma \
  --embedding-model google/embeddinggemma-300M \
  --embedding-model-path models/embeddinggemma-300m \
  --embedding-command .venv-embeddinggemma/bin/python \
  --embedding-dimensions 768
```

Useful local flags:

```bash
# Apple Silicon acceleration
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-device mps

# Use the project venv Python explicitly
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-command .venv-embeddinggemma/bin/python

# Install dependencies and authenticate without downloading
npm run setup:embeddinggemma -- --skip-download

# Smaller Matryoshka vector for quick local experiments
npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-dimensions 256
```

Keep Hugging Face tokens local only: use the interactive `hf auth login`, a local keychain, or an uncommitted shell environment variable such as `HF_TOKEN`.

Relevant Google docs:

- https://ai.google.dev/gemma/docs/embeddinggemma
- https://ai.google.dev/gemma/docs/embeddinggemma/inference-embeddinggemma-with-sentence-transformers

Google describes EmbeddingGemma as:

- a local/on-device embedding model;
- 308M parameters;
- 768-dimensional embeddings by default;
- flexible output dimensions down to 128 through Matryoshka Representation Learning;
- suitable for offline/private embedding workflows.

### EmbeddingGemma Implementation

Implemented files:

```text
scripts/import_accelerator_dataset.mjs
scripts/embed_embeddinggemma.py
scripts/embed_embeddinggemma_worker.py
scripts/setup_embeddinggemma.sh
scripts/ask_map_server.mjs
requirements-embeddinggemma.txt
tests/accelerator/importer.test.js
```

How it works:

1. `npm run import:accelerator -- --embedding-provider embeddinggemma` calls `buildEmbeddingGemmaRecords`.
2. The Node importer spawns `scripts/embed_embeddinggemma.py`.
3. The Python sidecar reads `{ items: [{ id, text }] }` JSON from stdin.
4. It loads `google/embeddinggemma-300M` with Sentence Transformers.
5. It encodes anonymized chunk text with `prompt_name="Retrieval-document"` by default.
6. It returns `{ id, embedding }` JSON to Node.
7. Node stores vectors as float arrays and BLOB hex, computes UMAP, writes local Turso seed SQL, and strips vector blobs from frontend JSON.

Open-ended Ask flow:

1. Run `npm run ask:server`.
2. Server creates/loads `data/accelerator/local/accelerator-seed.sqlite` from schema + seed SQL.
3. Browser sends typed question to `POST /api/ask-map`.
4. Server embeds question locally with a persistent EmbeddingGemma worker using `Retrieval-query`.
5. Server cosine-ranks stored 768-dimensional chunk vectors.
6. Server returns cautious synthesis, evidence, participant codes, themes, and highlighted map item IDs.
7. Browser highlights the existing UMAP nodes and opens the Evidence panel.

UMAP is not used for retrieval. It is only the map layout.

Still useful future options:

- Add `--embedding-input path/to/vectors.jsonl` for externally precomputed local vectors.
- Add a local HTTP embedding service at `127.0.0.1` if multiple tools will share the loaded model.

### Embedding Record Requirements

Every embedding record should include:

```js
{
  id: `${chunk.id}-embedding`,
  chunk_id: chunk.id,
  embedding_provider: 'embeddinggemma',
  embedding_model: 'google/embeddinggemma-300M',
  embedding_dimensions: vector.length,
  embedding_vector: vector,
  vector_blob_hex: Buffer.from(Float32Array.from(vector).buffer).toString('hex'),
  vector_sha256: sha256(bytes),
  input_sha256: sha256(chunk.anonymized_text),
  metadata_json: {
    runtime: 'sentence-transformers',
    normalized: true,
    local_only: true
  }
}
```

The Turso SQL exporter already stores `vector_blob_hex` as:

```sql
embedding_vector = X'...'
```

The frontend JSON export strips `vector_blob_hex`.

### UMAP Requirements

UMAP must stay outside the browser.

Current UMAP function:

```text
computeUmapCoordinates(embeddings)
```

This accepts embedding vectors, fits UMAP, normalizes coordinates to `[0,1]`, and writes `umap_x` / `umap_y`.

For production data:

- use the generated stable projection version, e.g. `umap-embeddinggemma-google-embeddinggemma-300m-v1`;
- store UMAP params in `params_json`;
- consider larger `n_neighbors` once there are enough chunks;
- keep seed/fixed randomness for repeatability;
- avoid rerunning UMAP in frontend.

## Mixed-Source Ingestion Gap

Current importer reads markdown files from:

```text
data/accelerator/raw/anonymized-interviews/
```

It should evolve to support all source types:

- interviews;
- prior interviews;
- social posts/public profiles;
- mentor notes;
- program material;
- reflections.

Recommended next format:

```text
data/accelerator/raw/sources/manifest.json
```

Example:

```json
{
  "participants": [
    {
      "id": "p-001",
      "display_code": "P-001",
      "role": "technical founder",
      "company_stage": "prototype",
      "cohort": "spring-2026",
      "profile_json": {
        "openness": 0.72,
        "conscientiousness": 0.64,
        "ambiguityComfort": 0.81,
        "trustInMentorship": 0.45,
        "publicPrivateTension": 0.66
      }
    }
  ],
  "sources": [
    {
      "id": "source-p-001-interview",
      "participant_id": "p-001",
      "source_type": "interview",
      "path": "sources/p-001/interview.md",
      "consent_level": "anonymized_research",
      "visibility": "researcher"
    },
    {
      "id": "source-p-001-mentor-note",
      "participant_id": "p-001",
      "source_type": "mentor_note",
      "path": "sources/p-001/mentor-note.md",
      "consent_level": "private_research",
      "visibility": "researcher"
    }
  ]
}
```

## Tests And Validation

Run:

```bash
npm test
npm run build
npm run test:accelerator:visual -- --project=chromium
```

Validate generated SQL:

```bash
rm -f /tmp/accelerator-seed.sqlite \
  && sqlite3 /tmp/accelerator-seed.sqlite < scripts/accelerator-schema.sql \
  && sqlite3 /tmp/accelerator-seed.sqlite < data/accelerator/exports/accelerator-seed.sql \
  && sqlite3 /tmp/accelerator-seed.sqlite "select count(*), count(embedding_vector), min(length(embedding_vector)), max(length(embedding_vector)) from embeddings;"
```

Expected for current local fixture:

```text
7|7|384|384
```

## Known Issues / Caveats

- `AGENTS.md` previously contained stale ContextLab/Khan-specific details. It has been replaced with accelerator-specific guidance.
- The OpenAI provider code exists but is not the desired production path.
- The EmbeddingGemma sidecar is implemented, but the real model run still depends on local Python dependencies, Gemma license access, and local Hugging Face auth.
- The importer currently has only basic deterministic theme inference.
- Ask-the-Map has local live retrieval when `npm run ask:server` is running; static sample answers remain as fallback.
- Real participant data has not been imported.
- No Turso cloud instance is configured in repo; this is intentional because Turso/libSQL is local-only for now.
- LiveKit voice UI is integrated locally with the official Agents UI Aura block, but the separate local voice agent/STT service still needs to be implemented.
- The repo still includes legacy Mapper code and tests.
- `npm audit` reports existing dependency vulnerabilities; not yet addressed.

## Security Notes

- `.env`, `.env.*`, `.credentials/`, logs, screenshots, and many generated artifacts are ignored.
- Do not commit secrets.
- Do not commit raw private transcripts.
- Do not paste API keys into docs, commits, issue comments, or PRs.
- An OpenAI API key was pasted into chat during this session. It was not written to files or committed. The owner should rotate/revoke it anyway.

Quick secret scan used:

```bash
rg -n "sk-proj-|OPENAI_API_KEY=\"sk|OPENAI_API_KEY='sk|OPENAI_API_KEY=sk" . \
  --glob '!node_modules/**' \
  --glob '!dist/**' \
  --glob '!package-lock.json'
```

No key was found in repo files.

## Suggested Next Steps

1. **Run and verify real local EmbeddingGemma**
   - Accept the Gemma license on Hugging Face if needed.
   - Run `npm run setup:embeddinggemma`.
   - Run `npm run import:accelerator -- --embedding-provider embeddinggemma --embedding-model google/embeddinggemma-300M --embedding-model-path models/embeddinggemma-300m --embedding-command .venv-embeddinggemma/bin/python`.
   - Inspect generated clusters and SQL vector BLOB lengths.

2. **Add mixed-source manifest ingestion**
   - Support interviews, prior interviews, social posts, mentor notes, program material, reflections.
   - Keep consent/visibility fields per source and chunk.

3. **Import first approved real data**
   - Start with 2-3 approved anonymized participants.
   - Validate source excerpts and consent levels manually.
   - Generate map and inspect node clusters.

4. **Upgrade Ask-the-Map retrieval**
   - Add better local synthesis once there is an approved local model policy.
   - Add approximate nearest-neighbor indexing once the chunk count is large.
   - Add stronger visibility tests for participant-facing mode.

5. **Researcher vs participant mode**
   - Researcher mode: detailed evidence and notes.
   - Participant mode: careful reflective wording and stricter visibility filtering.

6. **LiveKit bridge**
   - Implement the local LiveKit voice agent/STT process.
   - Publish final transcripts on topic `mapper.transcript`.
   - Add backend map-action messages if the voice agent should drive more than question submission.
   - Keep LiveKit local-only for this phase.
   - Have voice agent return `mapper:action` payloads or call the existing local Ask endpoint.

7. **CI and governance**
   - Add no-secret scan.
   - Add importer smoke test.
   - Add schema migration checks.
   - Add privacy visibility tests.

## Developer Orientation

Start here:

1. Read `README.md`.
2. Read this file.
3. Run `npm install`.
4. Run `npm test`.
5. Run `npm run dev`.
6. Open the app and select `Accelerator Seed Interviews`.
7. Inspect:
   - `scripts/import_accelerator_dataset.mjs`
   - `scripts/accelerator-schema.sql`
   - `src/app.js`
   - `src/ui/quiz.js`
   - `src/ui/video-panel.js`
   - `src/viz/renderer.js`

The next high-leverage PR should run the real local EmbeddingGemma model on approved anonymized inputs and add the mixed-source manifest scaffold.
