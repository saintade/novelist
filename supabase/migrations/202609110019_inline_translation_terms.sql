create or replace function public.save_translation_term_edit(preview_id uuid, source_spelling text, previous_target text, preferred_target text, preferred_category text, preferred_scope text, preferred_sense text, preferred_aliases text[], edited_result jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare preview public.book_translation_previews%rowtype; novel_key uuid; original_term jsonb; expected_terms jsonb; entry_key uuid; new_preview uuid; selected_source_language text;
begin
  select * into preview from public.book_translation_previews where owner_id = auth.uid() and id = preview_id and kind = 'chapter';
  if not found then raise exception 'Translation version not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || preview.book_id || ':translation',0));
  select novel_id into novel_key from public.books where owner_id = auth.uid() and id = preview.book_id;
  if not found then raise exception 'Book not found' using errcode = 'P0002'; end if;
  if preferred_scope not in ('novel','global') or preferred_category not in ('person','place','organization','item','rank','technique','concept')
    or coalesce(length(trim(preferred_target)),0) not between 1 and 200 or coalesce(length(source_spelling),0) not between 1 and 160
    or length(preferred_sense) > 300 or cardinality(preferred_aliases) > 12 then raise exception 'Invalid term preference'; end if;
  select term into original_term from jsonb_array_elements(preview.result->'terminology') term
    where term->>'source' = source_spelling and term->>'target' = previous_target limit 1;
  if original_term is null or strpos(coalesce(preview.context->'source'->>'text',''),source_spelling) = 0 then raise exception 'This term has no source evidence in the selected version'; end if;
  select jsonb_agg(case when term->>'source' = source_spelling and term->>'target' = previous_target then jsonb_set(term,'{target}',to_jsonb(trim(preferred_target))) else term end)
    into expected_terms from jsonb_array_elements(preview.result->'terminology') term;
  if edited_result->'terminology' is distinct from expected_terms or edited_result->>'title' is distinct from preview.result->>'title'
    or jsonb_typeof(edited_result->'paragraphs') is distinct from 'array'
    or jsonb_array_length(edited_result->'paragraphs') <> jsonb_array_length(preview.result->'paragraphs') then raise exception 'Invalid edited translation'; end if;
  selected_source_language := preview.context->'source'->>'language';
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || preferred_scope || source_spelling || preferred_sense || preview.target_language,0));
  select id into entry_key from public.glossary_entries where owner_id = auth.uid() and scope = preferred_scope
    and novel_id is not distinct from (case when preferred_scope = 'global' then null else novel_key end)
    and source_term = source_spelling and sense = preferred_sense and target_language = preview.target_language
    and split_part(lower(replace(glossary_entries.source_language,'_','-')),'-',1) = split_part(lower(replace(selected_source_language,'_','-')),'-',1)
    order by (status = 'approved') desc, updated_at desc limit 1 for update;
  if entry_key is null then
    insert into public.glossary_entries(scope,novel_id,source_term,target_term,source_language,target_language,category,sense,aliases,evidence,notes,status)
      values (preferred_scope,case when preferred_scope = 'global' then null else novel_key end,source_spelling,trim(preferred_target),selected_source_language,preview.target_language,preferred_category,preferred_sense,preferred_aliases,coalesce(original_term->>'evidenceQuote',source_spelling),'Reader correction from version ' || preview_id::text,'approved');
  else
    update public.glossary_entries set target_term = trim(preferred_target),category = preferred_category,aliases = preferred_aliases,status = 'approved'
      where owner_id = auth.uid() and id = entry_key;
  end if;
  insert into public.book_translation_previews(book_id,kind,source_key,target_language,result,context,model,input_tokens,output_tokens)
    values (preview.book_id,'chapter',preview.source_key,preview.target_language,edited_result,
      preview.context || jsonb_build_object('manualEdit',jsonb_build_object('parentVersion',preview_id,'source',source_spelling,'previous',previous_target,'preferred',preferred_target)),
      'manual edit',0,0) returning id into new_preview;
  return new_preview;
end;
$$;
revoke all on function public.save_translation_term_edit(uuid,text,text,text,text,text,text,text[],jsonb) from public,anon;
grant execute on function public.save_translation_term_edit(uuid,text,text,text,text,text,text,text[],jsonb) to authenticated;