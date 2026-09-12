create or replace function public.complete_batch_translation(target_batch uuid, chapter_position integer, worker_key uuid, snapshot jsonb, draft jsonb, consumed_input integer, consumed_output integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype; chapter public.translation_batch_chapters%rowtype; result jsonb;
begin
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key for update;
  if not found then raise exception 'The queue worker changed. No translation was saved' using errcode = '40001'; end if;
  select * into chapter from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and position = chapter_position for update;
  if not found or chapter.state is distinct from 'running' then raise exception 'This chapter is not active in the queue' using errcode = '40001'; end if;
  if snapshot->'source'->>'key' is distinct from chapter.source_key or snapshot->'source'->>'sourceId' is distinct from batch.source_id::text then raise exception 'The chapter source changed'; end if;
  if chapter.content_hash is not null and (
    snapshot->'source'->>'storageHash' is distinct from chapter.content_hash
    or not exists (select 1 from public.source_chapters where owner_id = auth.uid() and source_id = batch.source_id and url = chapter.source_key and content_hash = chapter.content_hash)
    or not exists (select 1 from public.novel_sources where owner_id = auth.uid() and id = batch.source_id and contents_data->'chapters'->chapter_position->>'url' = chapter.source_key)
  ) then raise exception 'The queued source changed while translating. Review a new range; the stale response was not saved' using errcode = '40001'; end if;
  result := public.complete_chapter_translation(batch.book_id,chapter.source_key,batch.settings_revision,batch.model,snapshot || jsonb_build_object('batch',jsonb_build_object('id',target_batch,'position',chapter_position)),draft,consumed_input,consumed_output);
  update public.translation_batch_chapters set state = 'completed',preview_id = (result->>'previewId')::uuid,completed_at = now(),error = '' where owner_id = auth.uid() and batch_id = target_batch and position = chapter_position;
  return result;
end;
$$;

create or replace function public.skip_batch_translation(target_batch uuid, chapter_position integer, worker_key uuid, saved_preview uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype; chapter public.translation_batch_chapters%rowtype;
begin
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key for update;
  if not found then raise exception 'Queue worker changed' using errcode = '40001'; end if;
  select * into chapter from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and position = chapter_position for update;
  if not found or chapter.state is distinct from 'running' or not exists (select 1 from public.book_translation_previews where owner_id = auth.uid() and id = saved_preview and book_id = batch.book_id and source_key = chapter.source_key and target_language = batch.target_language and kind = 'chapter') then raise exception 'Saved translation does not match this queued chapter'; end if;
  if chapter.content_hash is not null and (
    not exists (select 1 from public.source_chapters where owner_id = auth.uid() and source_id = batch.source_id and url = chapter.source_key and content_hash = chapter.content_hash)
    or not exists (select 1 from public.novel_sources where owner_id = auth.uid() and id = batch.source_id and contents_data->'chapters'->chapter_position->>'url' = chapter.source_key)
  ) then raise exception 'The queued source changed while checking its saved translation' using errcode = '40001'; end if;
  update public.translation_batch_chapters set state = 'skipped',preview_id = saved_preview,completed_at = now(),error = '' where owner_id = auth.uid() and batch_id = target_batch and position = chapter_position;
end;
$$;

create or replace function public.fail_translation_batch(target_batch uuid, worker_key uuid, failure_message text) returns void
language plpgsql security invoker set search_path = '' as $$
declare stopping boolean;
begin
  select state = 'cancelling' into stopping from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key for update;
  if not found then return; end if;
  update public.translation_batch_chapters set state = 'failed',error = left(failure_message,2000) where owner_id = auth.uid() and batch_id = target_batch and state = 'running';
  if stopping then update public.translation_batch_chapters set state = 'cancelled' where owner_id = auth.uid() and batch_id = target_batch and state = 'pending'; end if;
  update public.translation_batches set state = case when stopping then 'cancelled' else 'failed' end,error = left(failure_message,2000),worker_id = null,lease_expires_at = null,updated_at = now()
    where owner_id = auth.uid() and id = target_batch;
end;
$$;