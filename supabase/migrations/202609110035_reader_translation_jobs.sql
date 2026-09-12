alter table public.translation_batches add column retranslate boolean not null default false;
alter table public.translation_batches add constraint retranslation_single_chapter
  check (not retranslate or (range_start = range_end and chapters_per_request = 1));

create function public.create_reader_translation_batch(request_id uuid, target_book text, chapter_position integer, expected_revision integer, chosen_model text, cost_estimate jsonb, new_version boolean) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare existing public.translation_batches%rowtype; batch_id uuid;
begin
  if new_version is null then raise exception 'Choose whether to create a new translation version'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  select * into existing from public.translation_batches where owner_id = auth.uid() and id = request_id;
  if found and existing.retranslate is distinct from new_version then
    raise exception 'This request ID belongs to a different translation operation' using errcode = '40001';
  end if;
  batch_id := public.create_grouped_translation_batch(request_id,target_book,chapter_position,chapter_position,expected_revision,chosen_model,cost_estimate,1);
  if existing.id is null then update public.translation_batches set retranslate = new_version where owner_id = auth.uid() and id = batch_id; end if;
  return batch_id;
end;
$$;
revoke all on function public.create_reader_translation_batch(uuid,text,integer,integer,text,jsonb,boolean) from public,anon;
grant execute on function public.create_reader_translation_batch(uuid,text,integer,integer,text,jsonb,boolean) to authenticated;