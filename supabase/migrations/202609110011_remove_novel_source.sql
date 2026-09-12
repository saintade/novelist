create function public.remove_novel_source(target_book text, target_source uuid) returns text[]
language plpgsql security invoker set search_path = '' as $$
declare
  novel_key uuid;
  source_book text;
  paths text[];
begin
  select novel_id into novel_key from public.books where owner_id = auth.uid() and id = target_book;
  if not found then raise exception 'Book not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select book_id into source_book from public.novel_sources
    where owner_id = auth.uid() and id = target_source and novel_id = novel_key for update;
  if not found then raise exception 'Source not found in this novel' using errcode = 'P0002'; end if;
  select coalesce(array_agg(content_path), array[]::text[]) into paths from public.source_chapters
    where owner_id = auth.uid() and source_id = target_source;
  update public.book_translation_settings set
    main_source_id = case when main_source_id = target_source then null else main_source_id end,
    reference_source_id = case when reference_source_id = target_source then null else reference_source_id end,
    metadata_source_id = case when metadata_source_id = target_source then null else metadata_source_id end,
    revision = revision + 1
    where owner_id = auth.uid() and (main_source_id = target_source or reference_source_id = target_source or metadata_source_id = target_source);
  update public.novels novel set style_profile_id = null
    where novel.owner_id = auth.uid() and novel.id = novel_key and exists (
      select 1 from public.style_profiles profile where profile.owner_id = novel.owner_id and profile.id = novel.style_profile_id
        and profile.inference->>'kind' = 'continuation' and profile.inference->>'referenceSourceId' = target_source::text
    );
  update public.books set source_url = null, catalog_metadata = jsonb_set(catalog_metadata, '{contents}', 'null'::jsonb)
    where owner_id = auth.uid() and id = source_book and format = 'WEB';
  delete from public.novel_sources where owner_id = auth.uid() and id = target_source and novel_id = novel_key;
  return paths;
end;
$$;
revoke all on function public.remove_novel_source(text,uuid) from public, anon;
grant execute on function public.remove_novel_source(text,uuid) to authenticated;