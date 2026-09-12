alter table public.translation_batches add column all_untranslated boolean not null default false;
alter table public.translation_batches drop constraint translation_batches_check;
alter table public.translation_batches add constraint translation_batches_range_end_check
  check (range_end between range_start and 20000 and (all_untranslated or range_end < range_start + 1000));

create function public.create_untranslated_translation_batch(request_id uuid, target_book text, chapter_count integer, expected_revision integer, chosen_model text, cost_estimate jsonb, maximum_group_size integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare existing public.translation_batches%rowtype; batch_id uuid; source public.novel_sources%rowtype; imported boolean; actual_count integer; inserted integer;
begin
  if chapter_count is null or chapter_count not between 1 and 20000 then raise exception 'Choose a book with 1-20,000 indexed chapters'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  select * into existing from public.translation_batches where owner_id = auth.uid() and id = request_id;
  if found then
    if existing.book_id is distinct from target_book or not existing.all_untranslated or existing.range_start <> 1
      or existing.range_end <> chapter_count or existing.chapters_per_request is distinct from maximum_group_size then
      raise exception 'This request ID belongs to a different translation operation' using errcode = '40001';
    end if;
    return existing.id;
  end if;
  batch_id := public.create_grouped_translation_batch(request_id,target_book,1,least(chapter_count,1000),expected_revision,chosen_model,cost_estimate,maximum_group_size);
  select source_record.* into source from public.novel_sources source_record
    join public.translation_batches batch on batch.owner_id = source_record.owner_id and batch.source_id = source_record.id
    where batch.owner_id = auth.uid() and batch.id = batch_id;
  imported := (source.id is null or source.book_id = target_book) and exists(select 1 from public.chapters where owner_id = auth.uid() and book_id = target_book);
  if imported then select count(*) into actual_count from public.chapters where owner_id = auth.uid() and book_id = target_book;
  else actual_count := jsonb_array_length(coalesce(source.contents_data->'chapters','[]'::jsonb)); end if;
  if actual_count <> chapter_count then raise exception 'The chapter inventory changed. Review untranslated chapters again' using errcode = '40001'; end if;
  update public.translation_batches set all_untranslated = true,range_end = chapter_count where owner_id = auth.uid() and id = batch_id;
  if chapter_count > 1000 then
    if imported then
      insert into public.translation_batch_chapters(batch_id,position,source_key,title)
        select batch_id,chapter.position,'local:' || chapter.position::text,chapter.title from public.chapters chapter
        where chapter.owner_id = auth.uid() and chapter.book_id = target_book and chapter.position between 1000 and chapter_count - 1;
    else
      insert into public.translation_batch_chapters(batch_id,position,source_key,title,content_hash)
        select batch_id,(chapter.ordinality - 1)::integer,chapter.value->>'url',coalesce(chapter.value->>'sourceTitle',chapter.value->>'title',stored.title),stored.content_hash
        from jsonb_array_elements(coalesce(source.contents_data->'chapters','[]'::jsonb)) with ordinality chapter
        join public.source_chapters stored on stored.owner_id = auth.uid() and stored.source_id = source.id and stored.url = chapter.value->>'url'
        where chapter.ordinality between 1001 and chapter_count;
    end if;
    get diagnostics inserted = row_count;
    if inserted <> chapter_count - 1000 then raise exception 'Download every indexed chapter before translating the whole book'; end if;
  end if;
  return batch_id;
end;
$$;
revoke all on function public.create_untranslated_translation_batch(uuid,text,integer,integer,text,jsonb,integer) from public,anon;
grant execute on function public.create_untranslated_translation_batch(uuid,text,integer,integer,text,jsonb,integer) to authenticated;