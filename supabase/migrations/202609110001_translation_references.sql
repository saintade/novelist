create table public.book_translation_settings (
  owner_id uuid not null default auth.uid(),
  book_id text not null,
  target_language text not null default 'en' check (target_language in ('en','zh','ja','ko','es','fr','de','pt','ru','vi')),
  reference_book_id text,
  reference_mode text not null default 'same_novel' check (reference_mode in ('same_novel','style_only')),
  revision integer not null default 1,
  primary key (owner_id, book_id),
  foreign key (owner_id, book_id) references public.books (owner_id, id) on delete cascade,
  foreign key (owner_id, reference_book_id) references public.books (owner_id, id) on delete set null (reference_book_id),
  check (book_id <> reference_book_id)
);

create table public.chapter_reference_pairs (
  owner_id uuid not null default auth.uid(),
  book_id text not null,
  source_key text not null check (length(source_key) between 1 and 2048),
  reference_book_id text not null,
  reference_position integer not null,
  primary key (owner_id, book_id, source_key, reference_book_id, reference_position),
  foreign key (owner_id, book_id) references public.books (owner_id, id) on delete cascade,
  foreign key (owner_id, reference_book_id, reference_position) references public.chapters (owner_id, book_id, position) on delete cascade,
  check (book_id <> reference_book_id)
);

alter table public.book_translation_settings enable row level security;
alter table public.chapter_reference_pairs enable row level security;
create policy "Own translation settings" on public.book_translation_settings for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own chapter reference pairs" on public.chapter_reference_pairs for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.book_translation_settings, public.chapter_reference_pairs to authenticated;

create function public.set_book_translation_settings(target_book text, target_language text, reference_book text, reference_mode text, expected_revision integer) returns void
language plpgsql security invoker set search_path = '' as $$
declare current_revision integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select revision into current_revision from public.book_translation_settings where owner_id = auth.uid() and book_id = target_book;
  if coalesce(current_revision, 0) <> expected_revision then raise exception 'Translation settings changed; refresh before saving' using errcode = '40001'; end if;
  if reference_book is not null and not exists (select 1 from public.chapters where owner_id = auth.uid() and book_id = reference_book) then
    raise exception 'The reference book needs stored chapter text';
  end if;
  insert into public.book_translation_settings (book_id, target_language, reference_book_id, reference_mode, revision)
    values (target_book, target_language, reference_book, reference_mode, coalesce(current_revision, 0) + 1)
    on conflict (owner_id, book_id) do update set target_language = excluded.target_language,
      reference_book_id = excluded.reference_book_id, reference_mode = excluded.reference_mode, revision = excluded.revision;
end;
$$;
revoke all on function public.set_book_translation_settings(text,text,text,text,integer) from public, anon;
grant execute on function public.set_book_translation_settings(text,text,text,text,integer) to authenticated;

create function public.set_chapter_reference_pair(target_book text, chapter_key text, reference_book text, positions integer[], expected_revision integer) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  if not exists (select 1 from public.book_translation_settings where owner_id = auth.uid() and book_id = target_book
    and reference_book_id = reference_book and reference_mode = 'same_novel' and revision = expected_revision) then
    raise exception 'The selected reference changed. Refresh and retry' using errcode = '40001';
  end if;
  if not exists (select 1 from public.chapters where owner_id = auth.uid() and book_id = target_book and 'local:' || position = chapter_key)
    and not exists (select 1 from public.books, jsonb_array_elements(coalesce(catalog_metadata->'contents'->'chapters', '[]'::jsonb)) as chapter
      where owner_id = auth.uid() and id = target_book and chapter->>'url' = chapter_key) then
    raise exception 'Source chapter not found';
  end if;
  if coalesce(cardinality(positions), 0) > 20 then raise exception 'Pair at most 20 reference chapters per source chapter'; end if;
  delete from public.chapter_reference_pairs where owner_id = auth.uid() and book_id = target_book and source_key = chapter_key and reference_book_id = reference_book;
  insert into public.chapter_reference_pairs (book_id, source_key, reference_book_id, reference_position)
    select target_book, chapter_key, reference_book, position from (select distinct unnest(positions) as position) as positions;
end;
$$;
revoke all on function public.set_chapter_reference_pair(text,text,text,integer[],integer) from public, anon;
grant execute on function public.set_chapter_reference_pair(text,text,text,integer[],integer) to authenticated;