create or replace function public.create_untranslated_translation_batch(request_id uuid, target_book text, chapter_count integer, expected_revision integer, chosen_model text, cost_estimate jsonb, maximum_group_size integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare existing public.translation_batches%rowtype; settings public.book_translation_settings%rowtype; source public.novel_sources%rowtype; imported boolean; actual_count integer; inserted integer;
begin
  if chapter_count is null or chapter_count not between 1 and 20000
    or maximum_group_size is null or maximum_group_size not between 1 and 10
    or coalesce(length(chosen_model),0) not between 1 and 120 or jsonb_typeof(cost_estimate) is distinct from 'object'
    then raise exception 'Choose a book with 1-20,000 indexed chapters and a group of 1-10'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  select * into existing from public.translation_batches where owner_id = auth.uid() and id = request_id;
  if found then
    if existing.book_id is distinct from target_book or not existing.all_untranslated or existing.range_start <> 1
      or existing.range_end <> chapter_count or existing.chapters_per_request is distinct from maximum_group_size then
      raise exception 'This request ID belongs to a different translation operation' using errcode = '40001';
    end if;
    return existing.id;
  end if;
  select * into settings from public.book_translation_settings where owner_id = auth.uid() and book_id = target_book and revision = expected_revision;
  if not found then raise exception 'Translation preferences changed. Review before translating' using errcode = '40001'; end if;
  select * into source from public.novel_sources where owner_id = auth.uid() and role <> 'metadata'
    and (id = settings.main_source_id or (settings.main_source_id is null and book_id = target_book)) order by created_at limit 1;
  imported := (source.id is null or source.book_id = target_book) and exists(select 1 from public.chapters where owner_id = auth.uid() and book_id = target_book);
  if imported then select count(*) into actual_count from public.chapters where owner_id = auth.uid() and book_id = target_book;
  else actual_count := jsonb_array_length(coalesce(source.contents_data->'chapters','[]'::jsonb)); end if;
  if actual_count <> chapter_count then raise exception 'The chapter inventory changed. Review untranslated chapters again' using errcode = '40001'; end if;
  insert into public.translation_batches(id,book_id,source_id,target_language,model,settings_revision,range_start,range_end,estimate,chapters_per_request,all_untranslated)
    values(request_id,target_book,source.id,settings.target_language,chosen_model,expected_revision,1,chapter_count,cost_estimate,maximum_group_size,true);
  if imported then
    insert into public.translation_batch_chapters(batch_id,position,source_key,title)
      select request_id,chapter.position,'local:' || chapter.position::text,chapter.title from public.chapters chapter
      where chapter.owner_id = auth.uid() and chapter.book_id = target_book;
  else
    insert into public.translation_batch_chapters(batch_id,position,source_key,title,content_hash)
      select request_id,(chapter.ordinality - 1)::integer,chapter.value->>'url',coalesce(chapter.value->>'sourceTitle',chapter.value->>'title',stored.title),stored.content_hash
      from jsonb_array_elements(coalesce(source.contents_data->'chapters','[]'::jsonb)) with ordinality chapter
      join public.source_chapters stored on stored.owner_id = auth.uid() and stored.source_id = source.id and stored.url = chapter.value->>'url';
  end if;
  get diagnostics inserted = row_count;
  if inserted = 0 then raise exception 'Download at least one chapter before translating'; end if;
  if cost_estimate ? 'count' and (cost_estimate->>'count')::integer <> inserted then
    raise exception 'The downloaded chapters changed. Review the translation job again' using errcode = '40001';
  end if;
  return request_id;
end;
$$;