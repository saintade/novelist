create table public.page_identifications (
  id uuid not null default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  source_url text not null check (source_url ~ '^https?://' and length(source_url) <= 2048),
  source_language text,
  output_language text not null,
  title text,
  author text,
  cover_url text,
  model text not null,
  prompt_version text not null,
  captured_html_hash text not null check (captured_html_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null check (jsonb_typeof(metadata) = 'object'),
  raw_extraction jsonb not null check (jsonb_typeof(raw_extraction) = 'object'),
  usage jsonb not null default '{}' check (jsonb_typeof(usage) = 'object'),
  created_at timestamptz not null default now(),
  primary key (owner_id, id)
);

create index page_identifications_by_source on public.page_identifications (owner_id, source_url, created_at desc);
alter table public.page_identifications enable row level security;
create policy "Own page identifications" on public.page_identifications for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, delete on public.page_identifications to authenticated;