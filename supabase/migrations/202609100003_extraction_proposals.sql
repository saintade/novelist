create function public.complete_term_extraction(
  extraction_id uuid,
  extraction_result jsonb,
  consumed_input integer,
  consumed_output integer
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  current_run public.translation_runs%rowtype;
  term jsonb;
begin
  select * into current_run from public.translation_runs
    where id = extraction_id and owner_id = auth.uid() and kind = 'extract_terms' for update;
  if not found or current_run.status <> 'running' then
    raise exception 'Extraction is not running';
  end if;
  if jsonb_typeof(extraction_result -> 'terms') is distinct from 'array' then
    raise exception 'Invalid extraction result';
  end if;
  if jsonb_array_length(extraction_result -> 'terms') > 80 then
    raise exception 'Too many term proposals';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(current_run.owner_id::text || current_run.novel_id::text, 0));
  for term in select value from jsonb_array_elements(extraction_result -> 'terms') loop
    if not exists (
      select 1 from public.glossary_entries
      where owner_id = current_run.owner_id and novel_id = current_run.novel_id
        and scope = 'novel' and source_term = term ->> 'sourceTerm' and sense = coalesce(term ->> 'sense', '')
        and source_language = (select language from public.books where owner_id = current_run.owner_id and id = current_run.book_id)
        and target_language = 'en' and status in ('approved', 'proposed')
    ) then
      insert into public.glossary_entries (owner_id, novel_id, scope, source_term, target_term, sense, category, aliases, evidence, source_language, status, run_id)
      values (
        current_run.owner_id, current_run.novel_id, 'novel', term ->> 'sourceTerm', term ->> 'targetTerm',
        coalesce(term ->> 'sense', ''), term ->> 'category',
        array(select jsonb_array_elements_text(coalesce(term -> 'aliases', '[]'::jsonb))),
        term ->> 'evidenceQuote',
        (select language from public.books where owner_id = current_run.owner_id and id = current_run.book_id),
        'proposed', current_run.id
      );
    end if;
  end loop;
  update public.translation_runs set status = 'completed', result = extraction_result,
    input_tokens = consumed_input, output_tokens = consumed_output, completed_at = now()
    where owner_id = current_run.owner_id and id = current_run.id;
end;
$$;
revoke all on function public.complete_term_extraction(uuid, jsonb, integer, integer) from public;
grant execute on function public.complete_term_extraction(uuid, jsonb, integer, integer) to authenticated;