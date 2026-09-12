create function public.claim_translation_worker(target_batch uuid, worker_key uuid, retry_failed boolean default false, automatic_resume boolean default false) returns void
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype;
begin
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch for update;
  if not found then raise exception 'Translation batch not found' using errcode = 'P0002'; end if;
  if automatic_resume and (
    not batch.resume_automatically or batch.state not in ('paused','failed')
    or batch.last_error_code not in ('server_restart','worker_interrupted')
    or exists(select 1 from public.translation_batch_chapters where owner_id = auth.uid() and batch_id = target_batch
      and state in ('pending','running','failed') and attempts >= batch.max_attempts)
  ) then raise exception 'This job no longer permits automatic recovery' using errcode = '40001'; end if;
  perform public.claim_translation_batch(target_batch,worker_key,retry_failed);
  update public.translation_batches set resume_automatically = true,retry_at = null where owner_id = auth.uid() and id = target_batch;
end;
$$;
revoke all on function public.claim_translation_worker(uuid,uuid,boolean,boolean) from public,anon;
grant execute on function public.claim_translation_worker(uuid,uuid,boolean,boolean) to authenticated;