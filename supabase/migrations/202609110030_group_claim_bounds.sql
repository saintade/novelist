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
    where owner_id = auth.uid() and batch_id = target_batch and state = 'pending'
    order by position limit greatest(0,allowed - 1) for update
  ) candidate;
  return next first_chapter;
  return query update public.translation_batch_chapters chapter set state = 'running',attempts = attempts + 1,started_at = now(),error = ''
    where chapter.owner_id = auth.uid() and chapter.batch_id = target_batch
      and chapter.position = any(coalesce(selected_positions,'{}'::integer[])) returning chapter.*;
end;
$$;