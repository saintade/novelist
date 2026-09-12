create table public.source_chapters (
  owner_id uuid not null default auth.uid(),
  id uuid not null default gen_random_uuid(),
  source_id uuid not null,
  url text not null check (length(url) between 1 and 2048),
  title text not null check (length(title) between 1 and 500),
  content_path text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  word_count integer not null check (word_count >= 0),
  provenance jsonb not null default '{}'::jsonb,
  downloaded_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, source_id, url),
  foreign key (owner_id, source_id) references public.novel_sources(owner_id, id) on delete cascade,
  check (content_path like owner_id::text || '/sources/' || source_id::text || '/%')
);
alter table public.source_chapters enable row level security;
create policy "Own source chapters" on public.source_chapters for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.source_chapters to authenticated;

create table public.source_reading_progress (
  owner_id uuid not null default auth.uid(),
  source_id uuid not null,
  chapter_url text not null,
  fraction double precision not null default 0 check (fraction between 0 and 1),
  updated_at timestamptz not null default now(),
  primary key (owner_id, source_id),
  foreign key (owner_id, source_id) references public.novel_sources(owner_id, id) on delete cascade
);
alter table public.source_reading_progress enable row level security;
create policy "Own source reading progress" on public.source_reading_progress for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.source_reading_progress to authenticated;