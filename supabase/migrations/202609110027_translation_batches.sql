create table public.translation_batches (
  id uuid not null,
  owner_id uuid not null default auth.uid(),
  book_id text not null,
  source_id uuid,
  target_language text not null,
  model text not null,
  settings_revision integer not null,
  range_start integer not null check (range_start between 1 and 20000),
  range_end integer not null check (range_end between range_start and range_start + 999),
  state text not null default 'paused' check (state in ('running','pausing','paused','failed','cancelling','cancelled','completed')),
  estimate jsonb not null default '{}'::jsonb,
  error text not null default '',
  worker_id uuid,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id,id),
  foreign key (owner_id,book_id) references public.books(owner_id,id) on delete cascade,
  foreign key (owner_id,source_id) references public.novel_sources(owner_id,id) on delete cascade
);
create unique index one_open_translation_batch on public.translation_batches(owner_id,book_id)
  where state not in ('cancelled','completed');

create table public.translation_batch_chapters (
  owner_id uuid not null default auth.uid(),
  batch_id uuid not null,
  position integer not null check (position between 0 and 19999),
  source_key text not null,
  title text not null,
  content_hash text,
  state text not null default 'pending' check (state in ('pending','running','completed','skipped','failed','cancelled')),
  preview_id uuid,
  attempts integer not null default 0,
  error text not null default '',
  started_at timestamptz,
  completed_at timestamptz,
  primary key (owner_id,batch_id,position),
  unique (owner_id,batch_id,source_key),
  foreign key (owner_id,batch_id) references public.translation_batches(owner_id,id) on delete cascade,
  foreign key (owner_id,preview_id) references public.book_translation_previews(owner_id,id) on delete set null (preview_id)
);
alter table public.translation_batches enable row level security;
alter table public.translation_batch_chapters enable row level security;
create policy "Own translation batches" on public.translation_batches for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "Own translation batch chapters" on public.translation_batch_chapters for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select,insert,update,delete on public.translation_batches,public.translation_batch_chapters to authenticated;

create function public.create_translation_batch(request_id uuid, target_book text, range_start integer, range_end integer, expected_revision integer, chosen_model text, cost_estimate jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare settings public.book_translation_settings%rowtype; source public.novel_sources%rowtype; existing public.translation_batches%rowtype; inserted integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  select * into existing from public.translation_batches where owner_id = auth.uid() and id = request_id;
  if found then
    if existing.book_id is distinct from target_book or existing.range_start is distinct from range_start or existing.range_end is distinct from range_end then raise exception 'Request ID already belongs to another range'; end if;
    return existing.id;
  end if;
  select * into settings from public.book_translation_settings where owner_id = auth.uid() and book_id = target_book and revision = expected_revision;
  if not found then raise exception 'Save current translation preferences before starting a range' using errcode = '40001'; end if;
  if range_start is null or range_end is null or range_start < 1 or range_end > 20000 or range_end < range_start or range_end - range_start >= 1000
    or coalesce(length(chosen_model),0) not between 1 and 120 or jsonb_typeof(cost_estimate) is distinct from 'object' then raise exception 'Choose a range of up to 1,000 chapters'; end if;
  select * into source from public.novel_sources where owner_id = auth.uid() and role <> 'metadata'
    and (id = settings.main_source_id or (settings.main_source_id is null and book_id = target_book)) order by created_at limit 1;
  insert into public.translation_batches(id,book_id,source_id,target_language,model,settings_revision,range_start,range_end,estimate)
    values (request_id,target_book,source.id,settings.target_language,chosen_model,expected_revision,range_start,range_end,cost_estimate);
  if exists (select 1 from public.chapters where owner_id = auth.uid() and book_id = target_book) and (source.id is null or source.book_id = target_book) then
    insert into public.translation_batch_chapters(batch_id,position,source_key,title)
      select request_id,chapter.position,'local:' || chapter.position::text,chapter.title from public.chapters chapter
      where chapter.owner_id = auth.uid() and chapter.book_id = target_book and chapter.position between range_start - 1 and range_end - 1;
  else
    insert into public.translation_batch_chapters(batch_id,position,source_key,title,content_hash)
      select request_id,(chapter.ordinality - 1)::integer,chapter.value->>'url',coalesce(chapter.value->>'sourceTitle',chapter.value->>'title','Chapter ' || chapter.ordinality),stored.content_hash
      from jsonb_array_elements(coalesce(source.contents_data->'chapters','[]'::jsonb)) with ordinality chapter
      join public.source_chapters stored on stored.owner_id = auth.uid() and stored.source_id = source.id and stored.url = chapter.value->>'url'
      where chapter.ordinality between range_start and range_end;
  end if;
  get diagnostics inserted = row_count;
  if inserted <> range_end - range_start + 1 then raise exception 'Download every chapter in the selected range before translating'; end if;
  return request_id;
end;
$$;

create function public.claim_translation_batch(target_batch uuid, worker_key uuid, retry_failed boolean default false) returns void
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype;
begin
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch for update;
  if not found then raise exception 'Translation batch not found' using errcode = 'P0002'; end if;
  if batch.state in ('completed','cancelled','cancelling') then raise exception 'This batch cannot be resumed'; end if;
  if batch.worker_id is not null and batch.lease_expires_at > now() then raise exception 'This batch still has an active worker' using errcode = '40001'; end if;
  if not retry_failed and exists (select 1 from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and state in ('running','failed')) then
    raise exception 'Confirm retrying the failed or interrupted chapter; earlier provider usage may have been charged';
  end if;
  if not exists (select 1 from public.book_translation_settings where owner_id = auth.uid() and book_id = batch.book_id and revision = batch.settings_revision) then
    raise exception 'Translation preferences changed. Cancel this queue and review a new range' using errcode = '40001';
  end if;
  update public.translation_batch_chapters set state = 'pending',error = '' where owner_id = auth.uid() and batch_id = target_batch and state in ('running','failed');
  update public.translation_batches set state = 'running',worker_id = worker_key,lease_expires_at = now() + interval '5 minutes',error = '',updated_at = now() where owner_id = auth.uid() and id = target_batch;
end;
$$;

create function public.claim_translation_batch_chapter(target_batch uuid, worker_key uuid) returns setof public.translation_batch_chapters
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype; selected_position integer;
begin
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key for update;
  if not found then return; end if;
  if batch.state in ('pausing','cancelling') then
    update public.translation_batches set state = case when batch.state = 'cancelling' then 'cancelled' else 'paused' end,worker_id = null,lease_expires_at = null,updated_at = now() where owner_id = auth.uid() and id = target_batch;
    if batch.state = 'cancelling' then update public.translation_batch_chapters set state = 'cancelled' where owner_id = auth.uid() and batch_id = target_batch and state = 'pending'; end if;
    return;
  end if;
  if batch.state <> 'running' or batch.lease_expires_at <= now() then return; end if;
  if exists (select 1 from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and state = 'running') then raise exception 'A chapter is already being translated'; end if;
  select position into selected_position from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and state = 'pending' order by position limit 1 for update;
  if not found then
    update public.translation_batches set state = 'completed',worker_id = null,lease_expires_at = null,updated_at = now() where owner_id = auth.uid() and id = target_batch;
    return;
  end if;
  update public.translation_batches set lease_expires_at = now() + interval '5 minutes',updated_at = now() where owner_id = auth.uid() and id = target_batch;
  return query update public.translation_batch_chapters set state = 'running',attempts = attempts + 1,started_at = now(),error = ''
    where owner_id = auth.uid() and batch_id = target_batch and position = selected_position returning *;
end;
$$;

create function public.control_translation_batch(target_batch uuid, command text) returns void
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype;
begin
  if command not in ('status','pause','cancel') then raise exception 'Invalid batch action'; end if;
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch for update;
  if not found then raise exception 'Translation batch not found' using errcode = 'P0002'; end if;
  if batch.state in ('cancelled','completed') then return; end if;
  if batch.worker_id is not null and batch.lease_expires_at > now() then
    if command <> 'status' then update public.translation_batches set state = case when command = 'cancel' then 'cancelling' else 'pausing' end,updated_at = now() where owner_id = auth.uid() and id = target_batch; end if;
    return;
  end if;
  if batch.worker_id is not null then
    update public.translation_batch_chapters set state = 'failed',error = 'Interrupted before completion was confirmed. Review before retrying; provider usage may have been charged.' where owner_id = auth.uid() and batch_id = target_batch and state = 'running';
  end if;
  update public.translation_batches set state = case when command = 'cancel' or batch.state = 'cancelling' then 'cancelled' when command = 'pause' or batch.worker_id is not null then 'paused' else state end,
    error = case when batch.worker_id is not null then 'The worker was interrupted. No paid request was automatically replayed.' else error end,worker_id = null,lease_expires_at = null,updated_at = now()
    where owner_id = auth.uid() and id = target_batch;
  if command = 'cancel' or batch.state = 'cancelling' then update public.translation_batch_chapters set state = 'cancelled' where owner_id = auth.uid() and batch_id = target_batch and state = 'pending'; end if;
end;
$$;

create function public.fail_translation_batch(target_batch uuid, worker_key uuid, failure_message text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key for update;
  if not found then return; end if;
  update public.translation_batch_chapters set state = 'failed',error = left(failure_message,2000) where owner_id = auth.uid() and batch_id = target_batch and state = 'running';
  update public.translation_batches set state = case when state = 'cancelling' then 'cancelled' else 'failed' end,error = left(failure_message,2000),worker_id = null,lease_expires_at = null,updated_at = now()
    where owner_id = auth.uid() and id = target_batch;
end;
$$;

create function public.complete_batch_translation(target_batch uuid, chapter_position integer, worker_key uuid, snapshot jsonb, draft jsonb, consumed_input integer, consumed_output integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype; chapter public.translation_batch_chapters%rowtype; result jsonb;
begin
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key for update;
  if not found then raise exception 'The queue worker changed. No translation was saved' using errcode = '40001'; end if;
  select * into chapter from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and position = chapter_position for update;
  if chapter.state <> 'running' then raise exception 'This chapter is not active in the queue' using errcode = '40001'; end if;
  if snapshot->'source'->>'key' is distinct from chapter.source_key or snapshot->'source'->>'sourceId' is distinct from batch.source_id::text then raise exception 'The chapter source changed'; end if;
  result := public.complete_chapter_translation(batch.book_id,chapter.source_key,batch.settings_revision,batch.model,snapshot || jsonb_build_object('batch',jsonb_build_object('id',target_batch,'position',chapter_position)),draft,consumed_input,consumed_output);
  update public.translation_batch_chapters set state = 'completed',preview_id = (result->>'previewId')::uuid,completed_at = now(),error = '' where owner_id = auth.uid() and batch_id = target_batch and position = chapter_position;
  return result;
end;
$$;

create function public.skip_batch_translation(target_batch uuid, chapter_position integer, worker_key uuid, saved_preview uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype; chapter public.translation_batch_chapters%rowtype;
begin
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key for update;
  if not found then raise exception 'Queue worker changed' using errcode = '40001'; end if;
  select * into chapter from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch and position = chapter_position for update;
  if chapter.state <> 'running' or not exists (select 1 from public.book_translation_previews where owner_id = auth.uid() and id = saved_preview and book_id = batch.book_id and source_key = chapter.source_key and target_language = batch.target_language and kind = 'chapter') then raise exception 'Saved translation does not match this queued chapter'; end if;
  update public.translation_batch_chapters set state = 'skipped',preview_id = saved_preview,completed_at = now(),error = '' where owner_id = auth.uid() and batch_id = target_batch and position = chapter_position;
end;
$$;

revoke all on function public.create_translation_batch(uuid,text,integer,integer,integer,text,jsonb),public.claim_translation_batch(uuid,uuid,boolean),public.claim_translation_batch_chapter(uuid,uuid),public.control_translation_batch(uuid,text),public.fail_translation_batch(uuid,uuid,text),public.complete_batch_translation(uuid,integer,uuid,jsonb,jsonb,integer,integer),public.skip_batch_translation(uuid,integer,uuid,uuid) from public,anon;
grant execute on function public.create_translation_batch(uuid,text,integer,integer,integer,text,jsonb),public.claim_translation_batch(uuid,uuid,boolean),public.claim_translation_batch_chapter(uuid,uuid),public.control_translation_batch(uuid,text),public.fail_translation_batch(uuid,uuid,text),public.complete_batch_translation(uuid,integer,uuid,jsonb,jsonb,integer,integer),public.skip_batch_translation(uuid,integer,uuid,uuid) to authenticated;