# Local Embedding And Dataset Pipeline

Last updated: 2026-05-22

This repo, `voicesofhim/mapper`, is the lead app repo for the accelerator
Knowledge Mapper. The sibling/root `shape-rotator` repo was a useful spike, but
it should not become the lead project. Any durable pipeline work should live
here so the future private GitHub repo can be created by cloning/pushing this
mapper repo.

## Current Pipeline Shape

The browser does not compute embeddings or UMAP. It reads static
Mapper-compatible domain JSON from a served data directory:

```text
data/domains/index.json
data/domains/<domain-id>.json
```

The local research pipeline produces those files from local inputs:

```text
raw source repo/files
  -> adapter script
  -> participants, sources, chunks, tags, themes
  -> local embedding provider
  -> local UMAP coordinates
  -> Turso/libSQL seed SQL
  -> static domain JSON for Mapper
```

The canonical schema is `scripts/accelerator-schema.sql`. It now has explicit
dataset buckets so temporary imports can be removed:

```text
datasets
import_batches
participants
sources
chunks
themes / chunk_themes
tags / chunk_tags
embeddings
umap_coordinates
research_questions / question_evidence
```

For deletes, use `dataset_id`. For SLAB, the bucket is:

```text
slab:shape-rotator-spring-2026
```

## What Gets Embedded

Today the importer creates one practical document embedding per chunk. The input
is built in `scripts/import_accelerator_dataset.mjs` from:

```text
title
summary
anonymized_text
Themes: ...
Source type: ...
```

Important privacy rule: only redacted/anonymized text is passed to the embedding
provider. Raw transcripts, raw source metadata, email fields, contact fields,
phone numbers, and token/key/password-looking assignments are not intentionally
embedded.

This is still a hybrid embedding. It is good enough for local visualization and
retrieval testing, but the next production step should split roles:

```text
map_document       -> mostly cleaned evidence text, minimal tags
retrieval_document -> evidence text plus selected source/taxonomy context
query              -> local query embeddings for Ask-the-Map
```

The schema already has `embeddings.embedding_role` so we can make that split
without changing the database shape again.

## Embedding Providers

Supported providers live in `scripts/import_accelerator_dataset.mjs`:

```bash
# Fast deterministic local fixture, useful for tests and smoke previews.
ACCELERATOR_EMBEDDING_PROVIDER=local npm run import:accelerator

# Expected local production path. Runs sentence-transformers locally.
ACCELERATOR_EMBEDDING_PROVIDER=embeddinggemma npm run import:accelerator
```

There is also an OpenAI provider in the script for mocked tests and historical
compatibility, but this project should use local processing for private data.
Do not use hosted embedding APIs for private corpora unless the team explicitly
changes the privacy posture.

Frontend JSON should never include vector blobs. The seed SQL can include vector
blobs for local Turso/libSQL. `stripEmbeddingVectors()` removes
`vector_blob_hex` before writing browser bundles.

## Tags Versus Themes

Use both, but for different jobs:

```text
tags
  Structured provenance/taxonomy used for filtering, deletion, auditing,
  source-type analysis, and future faceted UI.

themes
  Mapper-visible labels used by the current top filter and map coloring UI.
```

Every SLAB item has a structured tag:

```text
{ type: "dataset", name: "SLAB" }
```

Every SLAB item also includes the visible theme:

```text
SLAB
```

That means the dataset dropdown can filter the repo bucket as `SLAB`, and the
theme dropdown can still filter the visible `SLAB` theme. The source dropdown is
for source types such as `application`, `interview`, `public_trace`, and
`derived_analysis`; it is not the right place for repo names. The database still
retains more precise tags such as `source_family`, `source_mode`, `depth_level`,
`manipulability_class`, and `acquisition_method`.

## SLAB Import Adapter

The first real source adapter is:

```text
scripts/import_slab_dataset.mjs
```

It reads a local checkout of:

```text
https://github.com/N0V3LT0K3NS/SLAB
```

Expected SLAB input shape:

```text
SLAB/
  data/shape-rotator-spring-2026/profiles/<subject>/
    profile-manifest.yaml
    evidence-store.json
```

The adapter treats each `evidence-store.json` record as one evidence chunk. It:

1. Creates an anonymized participant display code like `SLAB-001`.
2. Hashes the external subject id instead of exposing it as the display code.
3. Skips empty/low-signal records.
4. Skips source fields that look like email/contact/phone/secret fields.
5. Redacts email addresses, phone numbers, `mailto:` links, and key/token/secret
   assignments before storage and embedding.
6. Converts SLAB source families into source types:
   `interview`, `application`, `public_trace`, `derived_analysis`, or `unknown`.
7. Adds `SLAB` as both a visible theme and structured dataset tag.
8. Builds local embeddings and UMAP coordinates.
9. Writes ignored local browser JSON and local seed SQL.

The local test run on 2026-05-22 produced:

```text
13 participants
772 sources
1452 chunks
30 skipped records
```

The generated browser bundle passed checks for:

```text
all map_items include theme "SLAB"
no vector_blob_hex in frontend JSON
no email address regex hits
no phone number regex hits
no unredacted key/token/password assignment regex hits
```

## Running SLAB Locally

Keep the SLAB repo and generated outputs local:

```bash
npm run import:slab -- --repo /path/to/SLAB
```

Default outputs are intentionally ignored by Git:

```text
data/private-domains/slab/all.json
data/private-domains/slab/index.json
data/private-exports/slab/slab-export.json
data/private-exports/slab/slab-seed.sql
```

Preview the local private bundle in the dev server with:

```text
http://localhost:5173/mapper/?domainDir=data/private-domains/slab
```

Use this override instead of overwriting tracked `data/domains/*`. To return to
the public checked-in domain files, open:

```text
http://localhost:5173/mapper/?domainDir=public
```

## Build Safety

`npm run build` now calls:

```text
scripts/copy_public_data.mjs
```

That script copies only committed public data paths into `dist`:

```text
data/domains
data/videos
data/accelerator/raw
data/accelerator/exports
```

It intentionally excludes `.working` scratch directories and:

```text
data/private-domains
data/private-exports
data/accelerator/local
```

This matters because local private preview bundles can be large and sensitive.

## How To Add The Next Data Repo

Do not reshape the app around each repo. Add a source-specific adapter that
normalizes into the same canonical model:

```text
participant
source
chunk
tags
themes
embedding record
UMAP coordinate
```

Recommended steps:

1. Add `scripts/import_<source>_dataset.mjs`.
2. Give the source a stable `dataset_id`, for example
   `<source>:<cohort-or-date>`.
3. Write outputs under `data/private-domains/<source>/` and
   `data/private-exports/<source>/` by default.
4. Redact or skip sensitive fields before writing chunks or building embedding
   inputs.
5. Preserve provenance in metadata using hashes where raw names/paths are not
   needed in the UI.
6. Add a source adapter test with a tiny fixture that proves redaction,
   bucketing, vector stripping, and expected tags.
7. Use `?domainDir=data/private-domains/<source>` for browser previews.
8. Do not commit generated private JSON, SQL, SQLite, or source corpora.

## Known Limitations To Refine

The current system is ready for local visualization testing, not final research
analysis.

Main refinement points:

```text
embedding roles
  Split map, retrieval, and query embeddings instead of using one hybrid input.

tag UI
  The app currently filters by themes. Structured tags are in the data model but
  do not yet have a first-class faceted filter UI.

Ask server
  The browser sends the active private `domainDir` to the local Ask server. For
  private static preview bundles, the server ranks evidence from that exact
  bundle and returns matching map item IDs, avoiding stale seed/synthetic IDs.
  The Turso/libSQL vector path remains available for public/default bundles and
  should be the next path to harden for private datasets once local vector DB
  promotion is explicit.

PII policy
  Regex redaction catches obvious contact/secret patterns. Future adapters may
  need source-specific allowlists/denylists or local NER before embedding.

Turso sync
  Seed SQL exists for local libSQL/Turso import, but remote Turso promotion
  should be explicit and gated so private previews do not drift into shared
  infrastructure accidentally.
```
