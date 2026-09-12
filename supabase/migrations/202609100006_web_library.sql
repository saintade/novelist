alter table public.books drop constraint books_format_check;
alter table public.books add constraint books_format_check check (format in ('EPUB', 'TXT', 'WEB'));
alter table public.books alter column original_path drop not null;
alter table public.books add constraint books_original_file_check check ((format = 'WEB' and original_path is null) or (format <> 'WEB' and original_path is not null));
alter table public.books add column source_cover_url text check (source_cover_url is null or source_cover_url ~ '^https?://');
alter table public.books add column catalog_metadata jsonb not null default '{}' check (jsonb_typeof(catalog_metadata) = 'object');
alter table public.books add column identification_id uuid;
alter table public.books add constraint books_identification_fk foreign key (owner_id, identification_id) references public.page_identifications (owner_id, id) on delete set null (identification_id);

create function public.add_identified_novel(
  identification uuid,
  reviewed_title text,
  reviewed_author text,
  contents_data jsonb,
  reference_sources jsonb,
  overwrite_existing boolean default false
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  source public.page_identifications%rowtype;
  existing public.books%rowtype;
  book_key text;
  novel_key uuid;
  canonical_url text;
  source_entry jsonb;
  metadata jsonb;
  already_saved boolean;
begin
  if auth.uid() is null then raise exception 'A library session is required'; end if;
  if length(trim(reviewed_title)) not between 1 and 500 or length(trim(reviewed_author)) not between 1 and 300 then
    raise exception 'Review the title and author before adding this book';
  end if;
  if coalesce(jsonb_typeof(contents_data), '') <> 'object' or coalesce(jsonb_typeof(reference_sources), '') <> 'array' or jsonb_array_length(reference_sources) > 5 then
    raise exception 'Invalid contents or linked versions';
  end if;
  select * into source from public.page_identifications where owner_id = auth.uid() and id = identification;
  if not found then raise exception 'Identification not found in this library'; end if;
  canonical_url := coalesce(nullif(source.metadata->>'indexUrl', ''), source.source_url);
  if canonical_url !~ '^https?://' then raise exception 'Invalid novel URL'; end if;
  book_key := md5('novelist-web:' || canonical_url);
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || book_key, 0));
  select * into existing from public.books where owner_id = auth.uid() and id = book_key for update;
  already_saved := found;
  if already_saved and existing.format <> 'WEB' then raise exception 'This identifier belongs to an imported book'; end if;
  novel_key := case when already_saved then existing.novel_id else gen_random_uuid() end;
  metadata := jsonb_build_object('inspection', source.metadata, 'sourceLanguage', source.source_language, 'outputLanguage', source.output_language, 'contents', contents_data, 'canonicalUrl', canonical_url);

  if not already_saved then
    insert into public.books (id, owner_id, novel_id, title, author, description, language, format, genre, original_path, source_cover_url, file_size, source, source_url, import_state, identification_id, catalog_metadata)
    values (book_key, auth.uid(), novel_key, trim(reviewed_title), trim(reviewed_author), coalesce((select string_agg(value->>'text', E'\n\n') from jsonb_array_elements(coalesce(source.metadata->'synopses', '[]'::jsonb))), ''), coalesce(source.source_language, 'und'), 'WEB', coalesce(source.metadata->'genres'->>0, 'Uncategorized'), null, source.cover_url, 0, 'Web source', source.source_url, 'ready', source.id, metadata);
    update public.novels set original_title = coalesce(source.metadata->>'originalTitle', ''), title = trim(reviewed_title), author = trim(reviewed_author)
    where owner_id = auth.uid() and id = novel_key;
  elsif overwrite_existing then
    if contents_data = '{}'::jsonb then metadata := jsonb_set(metadata, '{contents}', coalesce(existing.catalog_metadata->'contents', '{}'::jsonb)); end if;
    update public.books set title = trim(reviewed_title), author = trim(reviewed_author),
      description = coalesce((select string_agg(value->>'text', E'\n\n') from jsonb_array_elements(coalesce(source.metadata->'synopses', '[]'::jsonb))), ''),
      source_cover_url = coalesce(source.cover_url, existing.source_cover_url), catalog_metadata = metadata, identification_id = source.id
    where owner_id = auth.uid() and id = book_key;
    update public.novels set title = trim(reviewed_title), author = trim(reviewed_author) where owner_id = auth.uid() and id = novel_key;
  end if;

  for source_entry in select value from jsonb_array_elements(reference_sources) loop
    if coalesce(source_entry->>'url', '') !~ '^https?://' or length(trim(coalesce(source_entry->>'label', ''))) not between 1 and 200 or length(coalesce(source_entry->>'language', '')) not between 2 and 35 then
      raise exception 'Invalid translated version';
    end if;
    insert into public.novel_sources (owner_id, novel_id, label, url, language, role, edition_label)
    values (auth.uid(), novel_key, source_entry->>'label', source_entry->>'url', source_entry->>'language', 'reference', '')
    on conflict (owner_id, novel_id, url, language, edition_label) do nothing;
  end loop;
  return jsonb_build_object('bookId', book_key, 'novelId', novel_key, 'alreadySaved', already_saved, 'updated', already_saved and overwrite_existing);
end;
$$;
revoke all on function public.add_identified_novel(uuid, text, text, jsonb, jsonb, boolean) from public, anon;
grant execute on function public.add_identified_novel(uuid, text, text, jsonb, jsonb, boolean) to authenticated;