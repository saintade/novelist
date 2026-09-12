update public.translation_batches set resume_automatically=false where state in ('paused','pausing','cancelled','cancelling','failed');

create or replace function public.control_translation_batch(target_batch uuid, command text) returns void
language plpgsql security invoker set search_path = '' as $$
declare batch public.translation_batches%rowtype;
begin
  if command not in ('status','pause','cancel','suspend') then raise exception 'Invalid batch action'; end if;
  select * into batch from public.translation_batches where owner_id=auth.uid() and id=target_batch for update;
  if not found then raise exception 'Translation batch not found' using errcode='P0002'; end if;
  if batch.state in ('cancelled','completed') then return; end if;
  if command in ('pause','cancel') then
    update public.translation_batches set resume_automatically=false where owner_id=auth.uid() and id=target_batch;
  end if;
  if batch.worker_id is not null and batch.lease_expires_at>now() then
    if command<>'status' then
      update public.translation_batches set state=case when command='cancel' or batch.state='cancelling' then 'cancelling' else 'pausing' end,
        last_error_code=case when command='suspend' and batch.resume_automatically then 'server_restart' else last_error_code end,
        updated_at=now() where owner_id=auth.uid() and id=target_batch;
    end if;
    return;
  end if;
  if batch.worker_id is not null then
    update public.translation_batch_chapters set state='failed',error='Worker interrupted before completion was confirmed. The job retry policy applies; earlier usage may have been charged.'
      where owner_id=auth.uid() and batch_id=target_batch and state='running';
  end if;
  update public.translation_batches set
    state=case when command='cancel' or batch.state='cancelling' then 'cancelled' when command in ('pause','suspend') or batch.worker_id is not null then 'paused' else state end,
    last_error_code=case when batch.worker_id is not null then 'worker_interrupted' when command='suspend' then 'server_restart' else last_error_code end,
    error=case when batch.worker_id is not null then 'The previous worker was interrupted.' else error end,
    worker_id=null,lease_expires_at=null,updated_at=now() where owner_id=auth.uid() and id=target_batch;
  if command='cancel' or batch.state='cancelling' then
    update public.translation_batch_chapters set state='cancelled' where owner_id=auth.uid() and batch_id=target_batch and state='pending';
  end if;
end;
$$;