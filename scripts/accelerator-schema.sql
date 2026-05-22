-- Canonical Turso/libSQL schema for Accelerator Observatory.
--
-- The frontend still consumes static Mapper-compatible JSON bundles in
-- data/domains/*.json. Turso/libSQL is the source of truth; exports flatten
-- this schema into map_items with precomputed x/y coordinates.
--
-- Privacy posture:
-- - Store anonymized excerpts for frontend display.
-- - Do not export raw transcripts by default.
-- - Keep consent and visibility fields on every participant, source, and chunk.
-- - Treat profile fields as research inferences, not diagnoses.

pragma foreign_keys = on;

create table if not exists datasets (
  id text primary key,
  name text not null,
  source_repo_url text,
  cohort text,
  status text not null default 'active'
    check (status in ('active', 'local_preview', 'archived', 'deleted')),
  metadata_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists import_batches (
  id text primary key,
  dataset_id text references datasets(id) on delete cascade,
  repo_url text,
  repo_commit_sha text,
  imported_at text not null default current_timestamp,
  importer_name text,
  metadata_json text not null default '{}'
);

create table if not exists participants (
  id text primary key,
  dataset_id text references datasets(id) on delete set null,
  display_code text not null,
  role text,
  company_stage text,
  cohort text,
  profile_json text not null default '{}',
  consent_level text not null default 'anonymized_research'
    check (consent_level in ('private_research', 'anonymized_research', 'participant_visible', 'public_approved', 'withdrawn')),
  visibility text not null default 'researcher'
    check (visibility in ('researcher', 'participant', 'public', 'restricted')),
  anonymization_level text not null default 'standard'
    check (anonymization_level in ('none', 'standard', 'strict')),
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (dataset_id, display_code)
);

create table if not exists sources (
  id text primary key,
  dataset_id text references datasets(id) on delete cascade,
  import_batch_id text references import_batches(id) on delete set null,
  participant_id text references participants(id) on delete set null,
  source_type text not null,
  title text,
  label text,
  source_ref text,
  source_uri_hash text,
  collected_at text,
  raw_text_ref text,
  raw_text_allowed integer not null default 0 check (raw_text_allowed in (0, 1)),
  source_path text,
  external_id text,
  content_sha256 text,
  consent_level text not null default 'anonymized_research'
    check (consent_level in ('private_research', 'anonymized_research', 'participant_visible', 'public_approved', 'withdrawn')),
  visibility text not null default 'researcher'
    check (visibility in ('researcher', 'participant', 'public', 'restricted')),
  metadata_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

create table if not exists chunks (
  id text primary key,
  dataset_id text references datasets(id) on delete cascade,
  import_batch_id text references import_batches(id) on delete set null,
  participant_id text not null references participants(id) on delete cascade,
  source_id text not null references sources(id) on delete cascade,
  chunk_index integer not null default 0,
  external_id text,
  content_sha256 text,
  source_type text not null,
  title text not null,
  summary text,
  anonymized_text text not null,
  excerpt text,
  sentiment text not null default 'neutral'
    check (sentiment in ('positive', 'neutral', 'mixed', 'negative', 'unknown')),
  confidence real not null default 0.75 check (confidence >= 0 and confidence <= 1),
  token_count integer,
  source_ref text,
  contains_sensitive_data integer not null default 0 check (contains_sensitive_data in (0, 1)),
  redaction_notes text,
  consent_level text not null default 'anonymized_research'
    check (consent_level in ('private_research', 'anonymized_research', 'participant_visible', 'public_approved', 'withdrawn')),
  visibility text not null default 'researcher'
    check (visibility in ('researcher', 'participant', 'public', 'restricted')),
  metadata_json text not null default '{}',
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp,
  unique (source_id, chunk_index)
);

create table if not exists themes (
  id text primary key,
  name text not null unique,
  description text,
  category text,
  created_at text not null default current_timestamp
);

create table if not exists chunk_themes (
  chunk_id text not null references chunks(id) on delete cascade,
  theme_id text not null references themes(id) on delete cascade,
  confidence real not null default 0.75 check (confidence >= 0 and confidence <= 1),
  evidence text,
  primary key (chunk_id, theme_id)
);

create table if not exists tags (
  id text primary key,
  tag_type text not null,
  name text not null,
  description text,
  created_at text not null default current_timestamp,
  unique (tag_type, name)
);

create table if not exists chunk_tags (
  chunk_id text not null references chunks(id) on delete cascade,
  tag_id text not null references tags(id) on delete cascade,
  origin text not null default 'imported',
  confidence real not null default 1 check (confidence >= 0 and confidence <= 1),
  rationale text,
  primary key (chunk_id, tag_id)
);

create table if not exists embeddings (
  id text primary key,
  chunk_id text not null references chunks(id) on delete cascade,
  embedding_role text not null default 'retrieval_document'
    check (embedding_role in ('map_document', 'retrieval_document', 'query')),
  embedding_provider text not null,
  embedding_model text not null,
  embedding_dimensions integer not null,
  embedding_vector blob,
  vector_sha256 text not null,
  input_sha256 text not null,
  created_at text not null default current_timestamp,
  metadata_json text not null default '{}',
  unique (chunk_id, embedding_role, embedding_model)
);

create table if not exists umap_coordinates (
  id text primary key,
  chunk_id text not null references chunks(id) on delete cascade,
  embedding_id text references embeddings(id) on delete set null,
  projection_method text not null default 'umap',
  projection_model text,
  projection_version text not null,
  umap_x real not null check (umap_x >= 0 and umap_x <= 1),
  umap_y real not null check (umap_y >= 0 and umap_y <= 1),
  params_json text not null default '{}',
  created_at text not null default current_timestamp,
  unique (chunk_id, projection_version)
);

create table if not exists research_questions (
  id text primary key,
  query text not null,
  synthesis text not null,
  suggested_follow_up text,
  themes_json text not null default '[]',
  participant_codes_json text not null default '[]',
  visibility text not null default 'researcher'
    check (visibility in ('researcher', 'participant', 'public', 'restricted')),
  metadata_json text not null default '{}',
  created_at text not null default current_timestamp
);

create table if not exists question_evidence (
  question_id text not null references research_questions(id) on delete cascade,
  chunk_id text not null references chunks(id) on delete cascade,
  rank integer not null default 0,
  rationale text,
  primary key (question_id, chunk_id)
);

create index if not exists idx_sources_participant on sources(participant_id);
create index if not exists idx_sources_dataset on sources(dataset_id);
create index if not exists idx_sources_type on sources(source_type);
create index if not exists idx_chunks_participant on chunks(participant_id);
create index if not exists idx_chunks_source on chunks(source_id);
create index if not exists idx_chunks_dataset on chunks(dataset_id);
create index if not exists idx_chunks_source_type on chunks(source_type);
create index if not exists idx_chunks_consent_visibility on chunks(consent_level, visibility);
create index if not exists idx_chunk_themes_theme on chunk_themes(theme_id);
create index if not exists idx_tags_type_name on tags(tag_type, name);
create index if not exists idx_chunk_tags_tag on chunk_tags(tag_id);
create index if not exists idx_embeddings_chunk on embeddings(chunk_id);
create index if not exists idx_embeddings_chunk_role on embeddings(chunk_id, embedding_role);
create index if not exists idx_umap_chunk_version on umap_coordinates(chunk_id, projection_version);

create view if not exists mapper_export_items as
select
  c.id,
  c.dataset_id,
  c.import_batch_id,
  c.participant_id,
  p.display_code,
  c.source_id,
  c.source_type,
  c.title,
  c.summary,
  c.anonymized_text,
  coalesce(c.excerpt, c.anonymized_text) as excerpt,
  c.sentiment,
  c.confidence,
  u.umap_x,
  u.umap_y,
  c.metadata_json,
  c.consent_level,
  c.visibility,
  e.embedding_provider,
  e.embedding_model,
  e.embedding_dimensions,
  e.vector_sha256,
  u.projection_method,
  u.projection_version,
  s.title as source_title,
  s.label as source_label,
  s.source_ref,
  s.metadata_json as source_metadata_json
from chunks c
join participants p on p.id = c.participant_id
join sources s on s.id = c.source_id
join umap_coordinates u on u.chunk_id = c.id
left join embeddings e on e.id = u.embedding_id
where c.consent_level != 'withdrawn'
  and c.visibility in ('researcher', 'participant', 'public');
