create table public.style_profiles (
  id uuid not null default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  instructions text not null default '' check (length(instructions) <= 6000),
  version integer not null default 1 check (version > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  unique (owner_id, name)
);

create table public.novels (
  id uuid not null default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  original_title text not null default '',
  author text not null default '',
  aliases text[] not null default '{}',
  style_profile_id uuid,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  foreign key (owner_id, style_profile_id) references public.style_profiles (owner_id, id)
);

alter table public.books add column novel_id uuid;
insert into public.novels (id, owner_id, title, author)
select md5(owner_id::text || ':' || id)::uuid, owner_id, title, author from public.books;
update public.books set novel_id = md5(owner_id::text || ':' || id)::uuid;
alter table public.books alter column novel_id set not null;
alter table public.books add constraint books_novel_fk foreign key (owner_id, novel_id) references public.novels (owner_id, id);
alter table public.books add constraint books_novel_identity unique (owner_id, id, novel_id);

create table public.novel_sources (
  id uuid not null default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  novel_id uuid not null,
  book_id text,
  label text not null check (length(trim(label)) between 1 and 200),
  url text check (url is null or url ~ '^https?://'),
  language text not null,
  role text not null default 'original' check (role in ('original', 'reference')),
  edition_label text not null default '',
  rights_status text not null default 'unreviewed' check (rights_status in ('unreviewed', 'public_domain_us', 'original_fixture', 'permission_granted')),
  rights_note text not null default '',
  original_path text,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  foreign key (owner_id, novel_id) references public.novels (owner_id, id) on delete cascade,
  foreign key (owner_id, book_id, novel_id) references public.books (owner_id, id, novel_id) on delete cascade,
  unique (owner_id, book_id),
  unique (owner_id, novel_id, url, language, edition_label)
);

create table public.translation_runs (
  id uuid not null default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  novel_id uuid not null,
  book_id text not null,
  chapter_position integer not null,
  kind text not null check (kind in ('extract_terms', 'translate', 'review')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed')),
  mode text not null check (mode in ('live', 'fixture')),
  model text not null,
  prompt_version text not null,
  input_hash text not null,
  context_snapshot jsonb not null default '{}',
  result jsonb,
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (owner_id, id),
  foreign key (owner_id, book_id, novel_id) references public.books (owner_id, id, novel_id) on delete cascade,
  foreign key (owner_id, book_id, chapter_position) references public.chapters (owner_id, book_id, position) on delete cascade
);
create index translation_runs_by_book on public.translation_runs (owner_id, book_id, created_at desc);

create table public.glossary_entries (
  id uuid not null default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  scope text not null check (scope in ('global', 'novel', 'chapter')),
  novel_id uuid,
  book_id text,
  chapter_position integer,
  source_term text not null check (length(trim(source_term)) between 1 and 160),
  target_term text not null check (length(trim(target_term)) between 1 and 200),
  sense text not null default '' check (length(sense) <= 300),
  category text not null check (category in ('person', 'place', 'organization', 'rank', 'technique', 'item', 'concept')),
  source_language text not null default 'zh',
  target_language text not null default 'en',
  aliases text[] not null default '{}',
  notes text not null default '' check (length(notes) <= 3000),
  evidence text not null default '',
  status text not null default 'approved' check (status in ('proposed', 'approved', 'rejected')),
  run_id uuid,
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, id),
  foreign key (owner_id, novel_id) references public.novels (owner_id, id) on delete cascade,
  foreign key (owner_id, book_id, novel_id) references public.books (owner_id, id, novel_id) on delete cascade,
  foreign key (owner_id, book_id, chapter_position) references public.chapters (owner_id, book_id, position) on delete cascade,
  foreign key (owner_id, run_id) references public.translation_runs (owner_id, id),
  check (
    (scope = 'global' and novel_id is null and book_id is null and chapter_position is null) or
    (scope = 'novel' and novel_id is not null and book_id is null and chapter_position is null) or
    (scope = 'chapter' and novel_id is not null and book_id is not null and chapter_position is not null)
  )
);
create unique index glossary_approved_identity on public.glossary_entries
  (owner_id, coalesce(novel_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(book_id, ''), coalesce(chapter_position, -1), source_language, target_language, source_term, sense)
  where status = 'approved';
create index glossary_by_novel on public.glossary_entries (owner_id, novel_id, scope);

create function public.prepare_novel_for_book() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.novel_id is null then
    new.novel_id := md5(new.owner_id::text || ':' || new.id)::uuid;
    insert into public.novels (id, owner_id, title, author)
    values (new.novel_id, new.owner_id, new.title, new.author)
    on conflict (owner_id, id) do nothing;
  end if;
  return new;
end;
$$;
create trigger prepare_novel before insert on public.books
for each row execute function public.prepare_novel_for_book();

create function public.capture_import_source() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.import_state = 'ready' then
    insert into public.novel_sources (owner_id, novel_id, book_id, label, url, language, original_path)
    values (new.owner_id, new.novel_id, new.id, new.source, new.source_url, new.language, new.original_path)
    on conflict (owner_id, book_id) do update set original_path = excluded.original_path;
  end if;
  return new;
end;
$$;
create trigger capture_source after insert or update of import_state on public.books
for each row execute function public.capture_import_source();

insert into public.novel_sources (owner_id, novel_id, book_id, label, url, language, original_path, rights_status, rights_note, verified_at)
select owner_id, novel_id, id, source, source_url, language, original_path,
  case when source_url in ('https://www.gutenberg.org/ebooks/11', 'https://www.gutenberg.org/ebooks/35', 'https://www.gutenberg.org/ebooks/113') then 'public_domain_us' else 'unreviewed' end,
  case when source_url in ('https://www.gutenberg.org/ebooks/11', 'https://www.gutenberg.org/ebooks/35', 'https://www.gutenberg.org/ebooks/113') then 'Project Gutenberg lists this edition as public domain in the USA. Checked 2026-09-10.' else '' end,
  case when source_url in ('https://www.gutenberg.org/ebooks/11', 'https://www.gutenberg.org/ebooks/35', 'https://www.gutenberg.org/ebooks/113') then now() else null end
from public.books where import_state = 'ready';

create function public.version_translation_metadata() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  if tg_table_name = 'style_profiles' then
    new.version := old.version + 1;
  else
    new.revision := old.revision + 1;
  end if;
  return new;
end;
$$;
create trigger version_style before update on public.style_profiles for each row execute function public.version_translation_metadata();
create trigger version_glossary before update on public.glossary_entries for each row execute function public.version_translation_metadata();

alter table public.style_profiles enable row level security;
alter table public.novels enable row level security;
alter table public.novel_sources enable row level security;
alter table public.translation_runs enable row level security;
alter table public.glossary_entries enable row level security;

create policy "Own style profiles" on public.style_profiles for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own novels" on public.novels for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own novel sources" on public.novel_sources for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own translation runs" on public.translation_runs for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own glossary entries" on public.glossary_entries for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.style_profiles, public.novels, public.novel_sources, public.translation_runs, public.glossary_entries to authenticated;

alter table public.library_settings add column translation_sample_imported boolean not null default false;