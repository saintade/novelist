alter table public.translation_batches add column max_attempts integer not null default 3 check (max_attempts between 1 and 5);
alter table public.translation_batches add column retry_at timestamptz;
alter table public.translation_batches add column last_error_code text not null default '';
alter table public.translation_batches add column resume_automatically boolean not null default true;

create function public.schedule_translation_retry(target_batch uuid, worker_key uuid, failure_message text, failure_code text, retry_delay_seconds integer) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype; retry_allowed boolean;
begin
  select * into batch from public.translation_batches where owner_id=auth.uid() and id=target_batch and worker_id=worker_key for update;
  if not found then raise exception 'Queue worker changed' using errcode='40001'; end if;
  if retry_delay_seconds is null or retry_delay_seconds not between 0 and 120 then raise exception 'Invalid retry delay'; end if;
  retry_allowed := batch.state='running' and batch.resume_automatically
    and failure_code in ('timeout','connection','rate_limit','provider_unavailable','output_limit','invalid_json','invalid_schema','incomplete_output','group_validation')
    and exists(select 1 from public.translation_batch_chapters where owner_id=auth.uid() and batch_id=target_batch and state='running')
    and not exists(select 1 from public.translation_batch_chapters where owner_id=auth.uid() and batch_id=target_batch and state='running' and attempts>=batch.max_attempts);
  update public.translation_batch_chapters set state=case when retry_allowed then 'pending' else 'failed' end,error=left(failure_message,2000)
    where owner_id=auth.uid() and batch_id=target_batch and state='running';
  if batch.state='cancelling' then
    update public.translation_batch_chapters set state='cancelled' where owner_id=auth.uid() and batch_id=target_batch and state='pending';
  end if;
  update public.translation_batches set
    state=case when retry_allowed then 'running' when batch.state='cancelling' then 'cancelled' when batch.state='pausing' then 'paused' else 'failed' end,
    retry_at=case when retry_allowed then now()+make_interval(secs=>retry_delay_seconds) else null end,
    lease_expires_at=case when retry_allowed then now()+interval '5 minutes'+make_interval(secs=>retry_delay_seconds) else null end,
    worker_id=case when retry_allowed then worker_key else null end,
    error=left(failure_message,2000),last_error_code=left(failure_code,80),updated_at=now()
    where owner_id=auth.uid() and id=target_batch;
  return retry_allowed;
end;
$$;
revoke all on function public.schedule_translation_retry(uuid,uuid,text,text,integer) from public,anon;
grant execute on function public.schedule_translation_retry(uuid,uuid,text,text,integer) to authenticated;