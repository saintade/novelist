create function public.renew_translation_batch_lease(target_batch uuid, worker_key uuid) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype;
begin
  select * into batch from public.translation_batches where owner_id = auth.uid() and id = target_batch for update;
  if not found or batch.worker_id is distinct from worker_key or batch.lease_expires_at is null or batch.lease_expires_at <= now() then
    raise exception 'The queue worker expired or changed. Review before resuming' using errcode = '40001';
  end if;
  if batch.state <> 'running' then return false; end if;
  update public.translation_batches set lease_expires_at = now() + interval '5 minutes',updated_at = now()
    where owner_id = auth.uid() and id = target_batch;
  return true;
end;
$$;
revoke all on function public.renew_translation_batch_lease(uuid,uuid) from public,anon;
grant execute on function public.renew_translation_batch_lease(uuid,uuid) to authenticated;