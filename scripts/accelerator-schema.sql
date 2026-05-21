-- Canonical Turso/libSQL shape for Accelerator Observatory exports.
-- The frontend consumes static JSON; this schema is the suggested source of truth.

create table if not exists participants (
  id text primary key,
  display_code text not null unique,
  role text,
  company_stage text,
  cohort text,
  profile_json text not null default '{}'
);

create table if not exists sources (
  id text primary key,
  participant_id text references participants(id),
  source_type text not null check (
    source_type in ('interview', 'prior_interview', 'social', 'mentor_note', 'program_material', 'reflection')
  ),
  label text,
  source_ref text,
  consent_level text,
  metadata_json text not null default '{}'
);

create table if not exists chunks (
  id text primary key,
  participant_id text references participants(id),
  source_id text references sources(id),
  source_type text not null,
  title text not null,
  summary text,
  anonymized_text text,
  excerpt text,
  sentiment text,
  confidence real,
  embedding_model text,
  embedding_vector blob,
  umap_x real not null,
  umap_y real not null,
  metadata_json text not null default '{}',
  consent_level text
);

create table if not exists themes (
  id text primary key,
  name text not null unique,
  description text
);

create table if not exists chunk_themes (
  chunk_id text references chunks(id),
  theme_id text references themes(id),
  confidence real,
  primary key (chunk_id, theme_id)
);
