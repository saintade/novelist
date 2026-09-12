create function public.materialize_source_book(target_source uuid) returns text
language plpgsql security invoker set search_path = '' as $$
declare
  reading_source public.novel_sources%rowtype;
  parent_book public.books%rowtype;
  identification public.page_identifications%rowtype;
  book_key text;
  novel_key uuid := gen_random_uuid();
  metadata jsonb;
begin
  select * into reading_source from public.novel_sources
    where owner_id = auth.uid() and id = target_source for update;
  if not found or reading_source.role = 'metadata' or reading_source.url is null then
    raise exception 'Choose a reading source in this library' using errcode = 'P0002';
  end if;
  if reading_source.book_id is not null then return reading_source.book_id; end if;
  select * into parent_book from public.books where owner_id = auth.uid()
    and novel_id = reading_source.novel_id order by added_at, id limit 1;
  if not found then raise exception 'The source has no library book' using errcode = 'P0002'; end if;
  book_key := md5('novelist-source:' || reading_source.id::text);
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || book_key, 0));
  if reading_source.identification_id is not null then
    select * into identification from public.page_identifications
      where owner_id = auth.uid() and id = reading_source.identification_id;
  end if;
  metadata := jsonb_build_object(
    'inspection', coalesce(identification.metadata, parent_book.catalog_metadata->'inspection', '{}'::jsonb),
    'sourceLanguage', reading_source.language,
    'outputLanguage', coalesce(identification.output_language, 'en'),
    'contents', reading_source.contents_data,
    'canonicalUrl', coalesce(reading_source.contents_data->>'url', reading_source.url)
  );
  insert into public.books(id,owner_id,novel_id,title,author,description,language,format,genre,original_path,source_cover_url,file_size,source,import_state)
    values (book_key,auth.uid(),novel_key,
      coalesce(nullif(identification.metadata->>'title',''),parent_book.title),
      coalesce(nullif(identification.metadata->>'author',''),parent_book.author),
      parent_book.description,reading_source.language,'WEB',parent_book.genre,null,
      coalesce(identification.cover_url,parent_book.source_cover_url),0,reading_source.label,'importing');
  update public.novels target set original_title = original.original_title, aliases = original.aliases,
    style_profile_id = original.style_profile_id
    from public.novels original where target.owner_id = auth.uid() and target.id = novel_key
      and original.owner_id = target.owner_id and original.id = reading_source.novel_id;
  insert into public.novel_sources(owner_id,novel_id,label,url,language,role,edition_label,rights_status,rights_note,verified_at,identification_id,contents_data,url_aliases)
    select owner_id,novel_key,label,url,language,role,edition_label,rights_status,rights_note,verified_at,identification_id,contents_data,url_aliases
    from public.novel_sources where owner_id = auth.uid() and novel_id = reading_source.novel_id and role = 'metadata';
  insert into public.glossary_entries(owner_id,scope,novel_id,source_term,target_term,sense,category,source_language,target_language,aliases,notes,evidence,status)
    select owner_id,scope,novel_key,source_term,target_term,sense,category,source_language,target_language,aliases,notes,evidence,status
    from public.glossary_entries where owner_id = auth.uid() and novel_id = reading_source.novel_id and scope = 'novel';
  update public.novel_sources set novel_id = novel_key, book_id = book_key, role = 'original'
    where owner_id = auth.uid() and id = target_source;
  update public.books set source_url = reading_source.url, catalog_metadata = metadata,
    identification_id = reading_source.identification_id, import_state = 'ready'
    where owner_id = auth.uid() and id = book_key;
  insert into public.book_translation_settings(book_id,target_language,main_source_id)
    values (book_key,coalesce((select target_language from public.book_translation_settings
      where owner_id = auth.uid() and book_id = parent_book.id),'en'),target_source);
  update public.book_translation_settings set main_source_id =
    (select id from public.novel_sources where owner_id = auth.uid() and book_id = parent_book.id and role <> 'metadata'),
    revision = revision + 1 where owner_id = auth.uid() and book_id = parent_book.id and main_source_id = target_source;
  update public.book_translation_previews set book_id = book_key where owner_id = auth.uid()
    and kind = 'chapter' and context->'source'->>'sourceId' = target_source::text;
  update public.source_analysis_runs set book_id = book_key where owner_id = auth.uid() and source_id = target_source;
  return book_key;
end;
$$;
revoke all on function public.materialize_source_book(uuid) from public, anon;
grant execute on function public.materialize_source_book(uuid) to authenticated;