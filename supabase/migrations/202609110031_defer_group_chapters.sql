create function public.defer_translation_group_chapters(target_batch uuid, worker_key uuid, chapter_positions integer[]) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform 1 from public.translation_batches where owner_id = auth.uid() and id = target_batch and worker_id = worker_key and lease_expires_at > now() for update;
  if not found then raise exception 'Queue worker changed' using errcode = '40001'; end if;
  if cardinality(chapter_positions) > 10 then raise exception 'Too many deferred chapters'; end if;
  update public.translation_batch_chapters set state = 'pending',attempts = greatest(0,attempts - 1),started_at = null,error = ''
    where owner_id = auth.uid() and batch_id = target_batch and position = any(chapter_positions) and state = 'running';
end;
$$;
revoke all on function public.defer_translation_group_chapters(uuid,uuid,integer[]) from public,anon;
grant execute on function public.defer_translation_group_chapters(uuid,uuid,integer[]) to authenticated;