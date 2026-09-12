alter table public.book_translation_settings add column main_source_id uuid;
alter table public.book_translation_settings add column metadata_source_id uuid;
alter table public.book_translation_settings add constraint settings_main_source_fk foreign key (owner_id, main_source_id) references public.novel_sources(owner_id, id) on delete set null (main_source_id);
alter table public.book_translation_settings add constraint settings_metadata_source_fk foreign key (owner_id, metadata_source_id) references public.novel_sources(owner_id, id) on delete set null (metadata_source_id);

drop function public.set_book_translation_settings(text,text,text,text,integer);
create function public.set_book_translation_settings(target_book text, target_language text, reference_book text, reference_mode text, expected_revision integer, main_source uuid, metadata_source uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare current_revision integer; novel_key uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select novel_id into novel_key from public.books where owner_id = auth.uid() and id = target_book;
  if not found then raise exception 'Book not found'; end if;
  select revision into current_revision from public.book_translation_settings where owner_id = auth.uid() and book_id = target_book;
  if coalesce(current_revision, 0) <> expected_revision then raise exception 'Translation settings changed; refresh before saving' using errcode = '40001'; end if;
  if reference_book is not null and not exists (select 1 from public.chapters where owner_id = auth.uid() and book_id = reference_book) then raise exception 'The reference book needs stored chapter text'; end if;
  if main_source is not null and not exists (select 1 from public.novel_sources where owner_id = auth.uid() and novel_id = novel_key and id = main_source and role <> 'metadata') then raise exception 'Choose a reading source for this novel'; end if;
  if metadata_source is not null and not exists (select 1 from public.novel_sources where owner_id = auth.uid() and novel_id = novel_key and id = metadata_source) then raise exception 'Choose a metadata source for this novel'; end if;
  insert into public.book_translation_settings (book_id, target_language, reference_book_id, reference_mode, revision, main_source_id, metadata_source_id)
    values (target_book, target_language, reference_book, reference_mode, coalesce(current_revision, 0) + 1, main_source, metadata_source)
    on conflict (owner_id, book_id) do update set target_language = excluded.target_language, reference_book_id = excluded.reference_book_id,
      reference_mode = excluded.reference_mode, revision = excluded.revision, main_source_id = excluded.main_source_id, metadata_source_id = excluded.metadata_source_id;
end;
$$;
revoke all on function public.set_book_translation_settings(text,text,text,text,integer,uuid,uuid) from public, anon;
grant execute on function public.set_book_translation_settings(text,text,text,text,integer,uuid,uuid) to authenticated;

create table public.book_translation_previews (
  id uuid not null default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  book_id text not null,
  kind text not null check (kind in ('metadata','chapter')),
  source_key text,
  target_language text not null,
  result jsonb not null,
  context jsonb not null,
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  foreign key (owner_id, book_id) references public.books(owner_id,id) on delete cascade
);
alter table public.book_translation_previews enable row level security;
create policy "Own translation previews" on public.book_translation_previews for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.book_translation_previews to authenticated;

create function public.apply_book_metadata(preview_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare preview public.book_translation_previews%rowtype; book public.books%rowtype;
begin
  select * into preview from public.book_translation_previews where owner_id = auth.uid() and id = preview_id and kind = 'metadata';
  if not found then raise exception 'Metadata preview not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || preview.book_id || ':translation', 0));
  select * into book from public.books where owner_id = auth.uid() and id = preview.book_id for update;
  if book.title is distinct from preview.context->>'originalTitle' or book.description is distinct from preview.context->>'originalDescription'
    or not exists (select 1 from public.book_translation_settings where owner_id = auth.uid() and book_id = preview.book_id and revision = (preview.context->>'settingsRevision')::integer) then
    raise exception 'Book or preferences changed. Create a new preview' using errcode = '40001';
  end if;
  if coalesce(length(trim(preview.result->>'title')),0) not between 1 and 500 or coalesce(length(preview.result->>'synopsis'),0) > 48000 then raise exception 'Invalid metadata preview'; end if;
  update public.books set title = preview.result->>'title', description = coalesce(preview.result->>'synopsis', ''),
    author = coalesce(nullif(preview.result->>'author', ''), author), source_cover_url = coalesce(nullif(preview.context->>'coverUrl', ''), source_cover_url)
    where owner_id = auth.uid() and id = preview.book_id;
  update public.book_translation_previews set applied_at = now() where owner_id = auth.uid() and id = preview_id;
end;
$$;
revoke all on function public.apply_book_metadata(uuid) from public, anon;
grant execute on function public.apply_book_metadata(uuid) to authenticated;

create or replace function public.set_chapter_reference_pair(target_book text, chapter_key text, reference_book text, positions integer[], expected_revision integer) returns void
language plpgsql security invoker set search_path = '' as $$
declare selected_source uuid; novel_key uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select main_source_id into selected_source from public.book_translation_settings where owner_id = auth.uid() and book_id = target_book
    and reference_book_id = reference_book and reference_mode = 'same_novel' and revision = expected_revision;
  if not found then raise exception 'The selected reference changed. Refresh and retry' using errcode = '40001'; end if;
  select novel_id into novel_key from public.books where owner_id = auth.uid() and id = target_book;
  if not exists (select 1 from public.chapters where owner_id = auth.uid() and book_id = target_book and 'local:' || position = chapter_key)
    and not exists (select 1 from public.books, jsonb_array_elements(coalesce(catalog_metadata->'contents'->'chapters', '[]'::jsonb)) as chapter where owner_id = auth.uid() and id = target_book and chapter->>'url' = chapter_key)
    and not exists (select 1 from public.novel_sources, jsonb_array_elements(coalesce(contents_data->'chapters', '[]'::jsonb)) as chapter where owner_id = auth.uid() and novel_id = novel_key and id = selected_source and chapter->>'url' = chapter_key) then raise exception 'Source chapter not found'; end if;
  if coalesce(cardinality(positions), 0) > 20 then raise exception 'Pair at most 20 reference chapters per source chapter'; end if;
  delete from public.chapter_reference_pairs where owner_id = auth.uid() and book_id = target_book and source_key = chapter_key and reference_book_id = reference_book;
  insert into public.chapter_reference_pairs (book_id, source_key, reference_book_id, reference_position)
    select target_book, chapter_key, reference_book, position from (select distinct unnest(positions) as position) as positions;
end;
$$;