alter table public.translation_batches add column request_kind text not null default 'bulk' check (request_kind in ('bulk','reader'));
update public.translation_batches set request_kind = 'reader' where retranslate;
drop index public.one_open_translation_batch;
create unique index one_open_translation_batch on public.translation_batches(owner_id,book_id)
  where request_kind = 'bulk' and state not in ('cancelled','completed');
create unique index one_open_reader_chapter on public.translation_batches(owner_id,book_id,source_id,range_start,target_language) nulls not distinct
  where request_kind = 'reader' and state not in ('cancelled','completed');
create index running_translation_chapters on public.translation_batch_chapters(owner_id,source_key,batch_id) where state = 'running';

create or replace function public.create_reader_translation_batch(request_id uuid, target_book text, chapter_position integer, expected_revision integer, chosen_model text, cost_estimate jsonb, new_version boolean) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare existing public.translation_batches%rowtype; settings public.book_translation_settings%rowtype; source public.novel_sources%rowtype; chapter_key text; chapter_title text; source_hash text; existing_id uuid;
begin
  if new_version is null or chapter_position is null or chapter_position not between 1 and 20000
    or coalesce(length(chosen_model),0) not between 1 and 120 or jsonb_typeof(cost_estimate) is distinct from 'object' then raise exception 'Invalid reader translation job'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  select * into existing from public.translation_batches where owner_id = auth.uid() and id = request_id;
  if found then
    if existing.book_id is distinct from target_book or existing.range_start is distinct from chapter_position
      or existing.range_end is distinct from chapter_position or existing.retranslate is distinct from new_version or existing.request_kind <> 'reader' then
      raise exception 'This request ID belongs to a different translation operation' using errcode = '40001';
    end if;
    return existing.id;
  end if;
  select * into settings from public.book_translation_settings where owner_id = auth.uid() and book_id = target_book and revision = expected_revision;
  if not found then raise exception 'Translation preferences changed. Review before translating' using errcode = '40001'; end if;
  select * into source from public.novel_sources where owner_id = auth.uid() and role <> 'metadata'
    and (id = settings.main_source_id or (settings.main_source_id is null and book_id = target_book)) order by created_at limit 1;
  if (source.id is null or source.book_id = target_book) and exists (select 1 from public.chapters where owner_id = auth.uid() and book_id = target_book) then
    select 'local:' || position::text,title into chapter_key,chapter_title from public.chapters
      where owner_id = auth.uid() and book_id = target_book and position = chapter_position - 1;
  else
    select stored.url,coalesce(chapter.value->>'sourceTitle',chapter.value->>'title',stored.title),stored.content_hash into chapter_key,chapter_title,source_hash
      from jsonb_array_elements(coalesce(source.contents_data->'chapters','[]'::jsonb)) with ordinality chapter
      join public.source_chapters stored on stored.owner_id = auth.uid() and stored.source_id = source.id and stored.url = chapter.value->>'url'
      where chapter.ordinality = chapter_position;
  end if;
  if chapter_key is null then raise exception 'Download this chapter before translating'; end if;
  select batch.id into existing_id from public.translation_batches batch
    join public.translation_batch_chapters chapter on chapter.owner_id = batch.owner_id and chapter.batch_id = batch.id
    where batch.owner_id = auth.uid() and batch.book_id = target_book and batch.source_id is not distinct from source.id
      and batch.target_language = settings.target_language and chapter.source_key = chapter_key
      and batch.state not in ('completed','cancelled') and (batch.request_kind = 'reader' or chapter.state = 'running')
    order by (chapter.state = 'running') desc,batch.created_at limit 1;
  if existing_id is not null then return existing_id; end if;
  insert into public.translation_batches(id,book_id,source_id,target_language,model,settings_revision,range_start,range_end,estimate,chapters_per_request,retranslate,request_kind)
    values (request_id,target_book,source.id,settings.target_language,chosen_model,expected_revision,chapter_position,chapter_position,cost_estimate,1,new_version,'reader');
  insert into public.translation_batch_chapters(batch_id,position,source_key,title,content_hash)
    values (request_id,chapter_position - 1,chapter_key,chapter_title,source_hash);
  return request_id;
end;
$$;

create function public.translation_chapter_busy(target_batch uuid, chapter_key text) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.translation_batch_chapters chapter
    join public.translation_batches other on other.owner_id = chapter.owner_id and other.id = chapter.batch_id
    join public.translation_batches current on current.owner_id = other.owner_id and current.book_id = other.book_id
    where current.owner_id = auth.uid() and current.id = target_batch and other.id <> current.id
      and other.source_id is not distinct from current.source_id and chapter.source_key = chapter_key and chapter.state = 'running');
$$;
revoke all on function public.translation_chapter_busy(uuid,text) from public,anon;
grant execute on function public.translation_chapter_busy(uuid,text) to authenticated;

create or replace function public.claim_translation_batch_chapter(target_batch uuid, worker_key uuid) returns setof public.translation_batch_chapters
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype; selected_position integer; book_key text;
begin
  select book_id into book_key from public.translation_batches where owner_id = auth.uid() and id = target_batch;
  if not found then return; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || book_key || ':translation-claim',0));
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key for update;
  if not found then return; end if;
  if batch.state in ('pausing','cancelling') then
    update public.translation_batches set state = case when batch.state = 'cancelling' then 'cancelled' else 'paused' end,worker_id = null,lease_expires_at = null,updated_at = now() where owner_id = auth.uid() and id = target_batch;
    if batch.state = 'cancelling' then update public.translation_batch_chapters set state = 'cancelled' where owner_id = auth.uid() and batch_id = target_batch and state = 'pending'; end if;
    return;
  end if;
  if batch.state <> 'running' or batch.lease_expires_at <= now() then return; end if;
  if exists (select 1 from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and state = 'running') then raise exception 'A chapter is already being translated'; end if;
  update public.translation_batches set lease_expires_at = now() + interval '5 minutes',updated_at = now() where owner_id = auth.uid() and id = target_batch;
  select position into selected_position from public.translation_batch_chapters
    where owner_id = auth.uid() and batch_id = target_batch and state = 'pending' and not public.translation_chapter_busy(target_batch,source_key)
    order by position limit 1 for update;
  if not found then
    if not exists (select 1 from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and state = 'pending') then
      update public.translation_batches set state = 'completed',worker_id = null,lease_expires_at = null,updated_at = now() where owner_id = auth.uid() and id = target_batch;
    end if;
    return;
  end if;
  return query update public.translation_batch_chapters set state = 'running',attempts = attempts + 1,started_at = now(),error = ''
    where owner_id = auth.uid() and batch_id = target_batch and position = selected_position returning *;
end;
$$;

create or replace function public.claim_translation_batch_group(target_batch uuid, worker_key uuid, maximum_chapters integer)
returns setof public.translation_batch_chapters
language plpgsql security invoker set search_path = '' as $$
declare first_chapter public.translation_batch_chapters%rowtype; allowed integer; selected_positions integer[];
begin
  if maximum_chapters is null or maximum_chapters not between 1 and 10 then raise exception 'Choose a group of 1-10 chapters'; end if;
  select * into first_chapter from public.claim_translation_batch_chapter(target_batch,worker_key);
  if not found then return; end if;
  select least(maximum_chapters,chapters_per_request) into allowed from public.translation_batches
    where owner_id = auth.uid() and id = target_batch and worker_id = worker_key;
  select array_agg(candidate.position) into selected_positions from (
    select position from public.translation_batch_chapters
    where owner_id = auth.uid() and batch_id = target_batch and state = 'pending' and not public.translation_chapter_busy(target_batch,source_key)
    order by position limit greatest(0,allowed - 1) for update
  ) candidate;
  return next first_chapter;
  return query update public.translation_batch_chapters chapter set state = 'running',attempts = attempts + 1,started_at = now(),error = ''
    where chapter.owner_id = auth.uid() and chapter.batch_id = target_batch
      and chapter.position = any(coalesce(selected_positions,'{}'::integer[])) returning chapter.*;
end;
$$;