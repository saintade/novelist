create table public.books (
  id text not null,
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  author text not null default 'Unknown author',
  description text not null default '',
  language text not null default 'en',
  format text not null check (format in ('EPUB', 'TXT')),
  genre text not null default 'Uncategorized',
  cover_path text,
  original_path text not null,
  word_count integer not null default 0 check (word_count >= 0),
  file_size bigint not null check (file_size >= 0),
  source text not null default 'Local import',
  source_url text,
  added_at timestamptz not null default now(),
  import_state text not null default 'importing' check (import_state in ('importing', 'ready')),
  primary key (owner_id, id)
);

create table public.chapters (
  owner_id uuid not null default auth.uid(),
  book_id text not null,
  position integer not null check (position >= 0),
  title text not null,
  word_count integer not null default 0 check (word_count >= 0),
  content_path text not null,
  primary key (owner_id, book_id, position),
  foreign key (owner_id, book_id) references public.books (owner_id, id) on delete cascade
);

create table public.reading_progress (
  owner_id uuid not null default auth.uid(),
  book_id text not null,
  chapter integer not null default 0 check (chapter >= 0),
  fraction double precision not null default 0 check (fraction between 0 and 1),
  status text not null default 'unread' check (status in ('unread', 'reading', 'finished')),
  last_read_at timestamptz,
  primary key (owner_id, book_id),
  foreign key (owner_id, book_id) references public.books (owner_id, id) on delete cascade
);

create table public.bookmarks (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  book_id text not null,
  chapter integer not null check (chapter >= 0),
  fraction double precision not null check (fraction between 0 and 1),
  title text not null,
  created_at timestamptz not null default now(),
  foreign key (owner_id, book_id) references public.books (owner_id, id) on delete cascade
);

create index bookmarks_by_book on public.bookmarks (owner_id, book_id);

create table public.library_settings (
  owner_id uuid primary key default auth.uid() references auth.users on delete cascade,
  samples_imported boolean not null default false
);

alter table public.books enable row level security;
alter table public.chapters enable row level security;
alter table public.reading_progress enable row level security;
alter table public.bookmarks enable row level security;
alter table public.library_settings enable row level security;

create policy "Own books" on public.books for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own chapters" on public.chapters for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own progress" on public.reading_progress for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own bookmarks" on public.bookmarks for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own settings" on public.library_settings for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

grant select, insert, update, delete on public.books, public.chapters, public.reading_progress, public.bookmarks, public.library_settings to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('library', 'library', false, 52428800, array['application/epub+zip', 'text/plain', 'application/json', 'image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

create policy "Read own library files" on storage.objects for select to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "Upload own library files" on storage.objects for insert to authenticated
  with check (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "Update own library files" on storage.objects for update to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid()::text))
  with check (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid()::text));
create policy "Delete own library files" on storage.objects for delete to authenticated
  using (bucket_id = 'library' and (storage.foldername(name))[1] = (select auth.uid()::text));