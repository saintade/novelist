create function public.create_grouped_translation_batch(request_id uuid, target_book text, range_start integer, range_end integer, expected_revision integer, chosen_model text, cost_estimate jsonb, maximum_group_size integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare existing_group integer; batch_id uuid;
begin
  if maximum_group_size is null or maximum_group_size not between 1 and 10 then raise exception 'Choose 1-10 chapters per request'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  select chapters_per_request into existing_group from public.translation_batches where owner_id = auth.uid() and id = request_id;
  if found and existing_group <> maximum_group_size then raise exception 'This request ID belongs to a different group size' using errcode = '40001'; end if;
  batch_id := public.create_translation_batch(request_id,target_book,range_start,range_end,expected_revision,chosen_model,cost_estimate);
  if existing_group is null then update public.translation_batches set chapters_per_request = maximum_group_size where owner_id = auth.uid() and id = batch_id; end if;
  return batch_id;
end;
$$;
revoke all on function public.create_grouped_translation_batch(uuid,text,integer,integer,integer,text,jsonb,integer) from public,anon;
grant execute on function public.create_grouped_translation_batch(uuid,text,integer,integer,integer,text,jsonb,integer) to authenticated;