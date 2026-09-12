create function public.complete_chapter_translation(target_book text, chapter_key text, expected_revision integer, translation_model text, snapshot jsonb, draft jsonb, consumed_input integer, consumed_output integer) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  novel_key uuid; selected_target text; selected_source text; source_text text; target_text text;
  preview_key uuid; term jsonb; terms_saved integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select book.novel_id, settings.target_language into novel_key, selected_target
    from public.books book join public.book_translation_settings settings
      on settings.owner_id = book.owner_id and settings.book_id = book.id
    where book.owner_id = auth.uid() and book.id = target_book and settings.revision = expected_revision;
  if not found then raise exception 'Translation preferences changed. Create a new draft' using errcode = '40001'; end if;
  source_text := snapshot->'source'->>'text';
  selected_source := snapshot->'source'->>'language';
  if coalesce(length(source_text),0) not between 1 and 18000
    or snapshot->'source'->>'key' is distinct from chapter_key
    or snapshot->>'targetLanguage' is distinct from selected_target
    or jsonb_typeof(draft->'paragraphs') is distinct from 'array'
    or jsonb_typeof(draft->'terminology') is distinct from 'array'
    or jsonb_array_length(draft->'terminology') > 80 then raise exception 'Invalid translation draft'; end if;
  select string_agg(paragraph, E'\n\n') into target_text from jsonb_array_elements_text(draft->'paragraphs') as paragraph;
  insert into public.book_translation_previews(book_id,kind,source_key,target_language,result,context,model,input_tokens,output_tokens)
    values (target_book,'chapter',chapter_key,selected_target,draft,snapshot,translation_model,consumed_input,consumed_output)
    returning id into preview_key;
  for term in select * from jsonb_array_elements(draft->'terminology') loop
    if coalesce(length(trim(term->>'source')),0) not between 1 and 160
      or coalesce(length(trim(term->>'target')),0) not between 1 and 200
      or coalesce(length(term->>'evidenceQuote'),0) not between 1 and 500
      or strpos(source_text,term->>'evidenceQuote') = 0
      or strpos(term->>'evidenceQuote',term->>'source') = 0
      or strpos(coalesce(target_text,''),term->>'target') = 0 then raise exception 'A glossary proposal lacks exact translation evidence'; end if;
    if not exists (select 1 from public.glossary_entries entry where entry.owner_id = auth.uid()
      and entry.novel_id = novel_key and entry.scope = 'novel' and entry.source_language = selected_source
      and entry.target_language = selected_target and entry.source_term = term->>'source'
      and entry.sense = coalesce(term->>'sense','')) then
      insert into public.glossary_entries(novel_id,scope,source_language,target_language,source_term,target_term,category,sense,evidence,notes,status)
        values (novel_key,'novel',selected_source,selected_target,term->>'source',term->>'target',term->>'category',coalesce(term->>'sense',''),term->>'evidenceQuote','Translation draft: ' || preview_key::text || E'\nSource chapter: ' || chapter_key,'proposed');
      terms_saved := terms_saved + 1;
    end if;
  end loop;
  return jsonb_build_object('previewId',preview_key,'termsSaved',terms_saved);
end;
$$;
revoke all on function public.complete_chapter_translation(text,text,integer,text,jsonb,jsonb,integer,integer) from public, anon;
grant execute on function public.complete_chapter_translation(text,text,integer,text,jsonb,jsonb,integer,integer) to authenticated;