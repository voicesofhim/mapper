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

For the next real data sources, use this cleaner target pipeline:

```text
raw repo data
  -> normalize participants/sources/chunks
  -> redact private fields
  -> derive structured tags/skills/needs
  -> store tags relationally
  -> build embedding text from approved fields
  -> embed locally
  -> compute UMAP
  -> export Mapper JSON / Turso seed
```

Do not create participant skills during embedding. Derive or assign skills,
needs, offers, and provenance during ingestion, then store them as auditable
structured metadata before any embedding call is made. Embeddings should consume
approved text and selected approved metadata; they should not be the only place
where tags exist.

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
map_document
  Mostly cleaned evidence text with minimal or no skill tags.
  Goal: preserve an honest semantic map shape.

retrieval_document
  Cleaned evidence text plus selected structured tags/source context.
  Goal: improve Ask-the-Map and cohort-matching retrieval.

query
  Local query embeddings for Ask-the-Map.
```

The schema already has `embeddings.embedding_role` so we can make that split
without changing the database shape again.

Turso/libSQL tags are the authoritative source for skills, needs, source types,
datasets, deletion, filtering, provenance, and future faceted UI. Embedding text
may include a small amount of selected tag context for retrieval, but the
relational tags must remain the source of truth.

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

For cohort-matching questions such as "Who should I seek guidance from on agent
coordination?", use structured tags rather than relying only on semantic
similarity. Example participant/chunk tags:

```text
participant_skill: agent_coordination
participant_skill: multi_agent_systems
participant_skill: workflow_automation
participant_need: agent_architecture_help
help_offer: technical_guidance
```

Those tags should be derived or assigned during ingestion, reviewed as
structured metadata, and stored in Turso/libSQL through `tags` and `chunk_tags`
or the next participant-level tag table if we add one. The answer layer should
combine those tags with retrieved evidence chunks, then cite the evidence behind
the recommendation.

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

## Partner Dataset Inspect / Approval Flow

For partner-owned tools with private labels, personality profiles, or their own
tagging mesh, use the generic partner adapter as the first integration point:

```bash
npm run import:partner -- --source /path/to/partner/export --mode inspect
```

Inspect mode does not embed or write Mapper bundles. It scans local JSON, JSONL,
Markdown, and text exports, then writes ignored review artifacts:

```text
data/private-exports/partner/import-report.md
data/private-exports/partner/import-report.json
data/private-exports/partner/label-inventory.json
data/private-exports/partner/tag-cooccurrence.json
data/private-exports/partner/privacy-findings.json
data/private-exports/partner/ontology-candidates.json
data/private-exports/partner/sample-records.json
data/private-exports/partner/import-approval.template.json
```

Review `import-report.md` and the approval template. Save an edited copy as:

```text
data/private-exports/partner/import-approval.json
```

Set `"approved": true`, remove fields that should not be stored or embedded,
and optionally merge labels into canonical ontology names:

```json
{
  "approved": true,
  "dataset_id": "partner:spring-2026",
  "approved_text_fields": ["profile_summary", "content"],
  "approved_label_fields": ["labels", "personality.traits", "support_needs"],
  "denied_fields": ["email", "phone", "legal_name", "private_admin_notes"],
  "approved_tag_types": ["personality_trait", "participant_need", "support_need"],
  "label_merges": {
    "personality_trait:high agency": "personality_trait:high_agency",
    "participant_need:needs structure": "support_need:execution_structure"
  }
}
```

Then run approved ingest:

```bash
npm run import:partner -- \
  --source /path/to/partner/export \
  --mode ingest \
  --approval data/private-exports/partner/import-approval.json
```

Ingest mode reruns the local scan, keeps only approved fields, redacts obvious
contact/secret values, maps partner labels into structured tags, then reuses the
existing local embedding, UMAP, SQL, and private Mapper bundle machinery. It
writes ignored outputs under:

```text
data/private-domains/partner/
data/private-exports/partner/partner-export.json
data/private-exports/partner/partner-seed.sql
data/private-exports/partner/ontology-report.json
```

Preview with:

```text
http://localhost:5173/mapper/?domainDir=data/private-domains/partner
```

This flow treats partner labels as candidate ontology evidence. The importer can
propose tag groups and co-occurrence patterns, but humans promote or reject them
through the approval file before anything enters the canonical map pipeline.

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
