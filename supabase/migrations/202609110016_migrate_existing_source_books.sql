do $$
declare
  legacy_source record;
  created_book text;
  original_subject text := current_setting('request.jwt.claim.sub',true);
  chapters_before text;
  progress_before text;
  matches_before text;
  converted integer := 0;
begin
  lock table public.source_chapters, public.source_reading_progress, public.source_chapter_alignments in share mode;
  select md5(coalesce(string_agg(to_jsonb(chapter)::text,',' order by owner_id,id),'')) into chapters_before from public.source_chapters chapter;
  select md5(coalesce(string_agg(to_jsonb(progress)::text,',' order by owner_id,source_id),'')) into progress_before from public.source_reading_progress progress;
  select md5(coalesce(string_agg(to_jsonb(pairing)::text,',' order by owner_id,source_id,source_url,reference_source_id),'')) into matches_before from public.source_chapter_alignments pairing;
  for legacy_source in
    select owner_id,id,novel_id from public.novel_sources where role <> 'metadata' and book_id is null and url is not null order by owner_id,created_at,id
  loop
    perform set_config('request.jwt.claim.sub',legacy_source.owner_id::text,true);
    update public.book_translation_settings settings set reference_mode = 'continuation', revision = revision + 1
      from public.books book where settings.owner_id = legacy_source.owner_id and book.owner_id = settings.owner_id
        and settings.book_id = book.id and book.novel_id = legacy_source.novel_id and settings.reference_mode = 'same_novel';
    created_book := public.materialize_source_book(legacy_source.id);
    update public.book_translation_settings settings set metadata_source_id = catalog.id
      from public.books book, public.novel_sources catalog
      where settings.owner_id = legacy_source.owner_id and settings.book_id = created_book and book.owner_id = settings.owner_id
        and book.id = created_book and catalog.owner_id = book.owner_id and catalog.novel_id = book.novel_id and catalog.role = 'metadata'
        and catalog.url ~ '^https?://(www\.)?novelupdates\.com/series/' and settings.metadata_source_id is null;
    converted := converted + 1;
  end loop;
  perform set_config('request.jwt.claim.sub',coalesce(original_subject,''),true);
  if chapters_before is distinct from (select md5(coalesce(string_agg(to_jsonb(chapter)::text,',' order by owner_id,id),'')) from public.source_chapters chapter)
    or progress_before is distinct from (select md5(coalesce(string_agg(to_jsonb(progress)::text,',' order by owner_id,source_id),'')) from public.source_reading_progress progress)
    or matches_before is distinct from (select md5(coalesce(string_agg(to_jsonb(pairing)::text,',' order by owner_id,source_id,source_url,reference_source_id),'')) from public.source_chapter_alignments pairing) then
    raise exception 'Source migration changed chapter records, reading positions or reviewed matches';
  end if;
  if exists (select 1 from public.novel_sources where role <> 'metadata' and book_id is null and url is not null) then
    raise exception 'Some reading sources still lack a library book';
  end if;
  raise notice 'Created % independent source books; chapter records, reading positions and matches are unchanged', converted;
end;
$$;