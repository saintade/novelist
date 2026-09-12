alter table public.book_translation_settings drop constraint book_translation_settings_reference_mode_check;
alter table public.book_translation_settings add constraint book_translation_settings_reference_mode_check
  check (reference_mode in ('same_novel','style_only','continuation'));
alter table public.book_translation_settings alter column reference_mode set default 'continuation';

create or replace function public.set_source_translation_settings(target_book text, target_language text, reference_book text, reference_mode text, expected_revision integer, main_source uuid, metadata_source uuid, reference_source uuid) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  if reference_source is not null then
    if reference_book is not null or main_source is null or main_source = reference_source then raise exception 'Choose a different context book'; end if;
    if not exists (select 1 from public.novel_sources where owner_id = auth.uid() and id = reference_source and role <> 'metadata'
      and book_id is distinct from target_book) then raise exception 'Choose a context book in this library'; end if;
  end if;
  update public.book_translation_settings set reference_source_id = null where owner_id = auth.uid() and book_id = target_book;
  perform public.set_book_translation_settings(target_book, target_language, reference_book, reference_mode, expected_revision, main_source, metadata_source);
  update public.book_translation_settings set reference_source_id = reference_source where owner_id = auth.uid() and book_id = target_book;
end;
$$;

create or replace function public.review_source_alignment(target_source uuid, chapter_url text, reference_source uuid, paired_urls text[], decision text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if decision not in ('confirmed','rejected') or cardinality(paired_urls) > 20 then raise exception 'Invalid alignment review'; end if;
  if not exists (select 1 from public.novel_sources original join public.novel_sources reference on reference.owner_id = original.owner_id
    where original.owner_id = auth.uid() and original.id = target_source and reference.id = reference_source
    and original.role <> 'metadata' and reference.role <> 'metadata' and original.id <> reference.id) then raise exception 'Choose two reading books in this library'; end if;
  if decision = 'confirmed' and (coalesce(cardinality(paired_urls),0) = 0 or exists (select 1 from unnest(paired_urls) as paired(url)
    where not exists (select 1 from public.source_chapters where owner_id = auth.uid() and source_id = reference_source and url = paired.url))) then raise exception 'Download each selected context chapter first'; end if;
  insert into public.source_chapter_alignments(source_id,source_url,reference_source_id,reference_urls,status,method)
    values (target_source,chapter_url,reference_source,case when decision = 'rejected' then '{}'::text[] else paired_urls end,decision,'manual')
    on conflict (owner_id,source_id,source_url,reference_source_id) do update set reference_urls = excluded.reference_urls, status = excluded.status, method = 'manual', reason = '', updated_at = now();
end;
$$;

create or replace function public.complete_source_analysis(target_book text, target_source uuid, chapter_url text, reference_source uuid, expected_revision integer, analysis_model text, snapshot jsonb, analysis jsonb, consumed_input integer, consumed_output integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare novel_key uuid; selected_source_language text; selected_target_language text; analysis_id uuid; term jsonb; paired text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select books.novel_id, settings.target_language into novel_key, selected_target_language from public.books books join public.book_translation_settings settings on settings.owner_id = books.owner_id and settings.book_id = books.id
    where books.owner_id = auth.uid() and books.id = target_book and settings.revision = expected_revision and settings.main_source_id = target_source and settings.reference_source_id = reference_source;
  if not found then raise exception 'Translation settings changed. Run the analysis again' using errcode = '40001'; end if;
  select language into selected_source_language from public.novel_sources where owner_id = auth.uid() and id = target_source and novel_id = novel_key and role <> 'metadata';
  if not found then raise exception 'Source not found'; end if;
  if not exists (select 1 from public.novel_sources where owner_id = auth.uid() and id = reference_source and id <> target_source and role <> 'metadata') then raise exception 'Context book not found'; end if;
  select coalesce(array_agg(match->>'url'),'{}'::text[]) into paired from jsonb_array_elements(analysis->'matches') as match;
  if cardinality(paired) > 20 or exists (select 1 from unnest(paired) as paired(url) where not exists (select 1 from public.source_chapters where owner_id = auth.uid() and source_id = reference_source and url = paired.url)) then raise exception 'Invalid context chapters'; end if;
  insert into public.source_analysis_runs(book_id,source_id,source_url,reference_source_id,model,context,result,input_tokens,output_tokens) values (target_book,target_source,chapter_url,reference_source,analysis_model,snapshot,analysis,consumed_input,consumed_output) returning id into analysis_id;
  insert into public.source_chapter_alignments(source_id,source_url,reference_source_id,reference_urls,status,method,reason)
    values (target_source,chapter_url,reference_source,paired,'proposed','model',coalesce(analysis->>'reason',''))
    on conflict (owner_id,source_id,source_url,reference_source_id) do update set reference_urls = excluded.reference_urls, reason = excluded.reason, updated_at = now()
      where public.source_chapter_alignments.status = 'proposed';
  for term in select * from jsonb_array_elements(analysis->'terms') loop
    if not exists (select 1 from public.glossary_entries entry where entry.owner_id = auth.uid() and entry.novel_id = novel_key and entry.scope = 'novel' and entry.source_language = selected_source_language and entry.target_language = selected_target_language and entry.source_term = term->>'sourceTerm' and entry.sense = coalesce(term->>'sense','')) then
      insert into public.glossary_entries(novel_id,scope,source_language,target_language,source_term,target_term,category,sense,aliases,evidence,notes,status)
        values (novel_key,'novel',selected_source_language,selected_target_language,term->>'sourceTerm',term->>'targetTerm',term->>'category',coalesce(term->>'sense',''),array(select jsonb_array_elements_text(term->'aliases')),term->>'evidenceQuote','Source: ' || chapter_url || E'\nReference: ' || coalesce(term->>'referenceQuote','') || E'\nAnalysis: ' || analysis_id::text,'proposed');
    end if;
  end loop;
  return analysis_id;
end;
$$;

create or replace function public.save_continuation_style(target_book text, reference_source uuid, expected_revision integer, expected_profile uuid, style_instructions text, style_metadata jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare novel_key uuid; novel_title text; selected_profile uuid; new_profile uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select book.novel_id, book.title into novel_key, novel_title from public.books book
    join public.book_translation_settings settings on settings.owner_id = book.owner_id and settings.book_id = book.id
    where book.owner_id = auth.uid() and book.id = target_book and settings.revision = expected_revision and settings.reference_source_id = reference_source;
  if not found then raise exception 'Translation settings changed. Update the guide again' using errcode = '40001'; end if;
  select style_profile_id into selected_profile from public.novels where owner_id = auth.uid() and id = novel_key for update;
  if selected_profile is distinct from expected_profile then raise exception 'Selected style changed. Reload before updating the guide' using errcode = '40001'; end if;
  if not exists (select 1 from public.novel_sources where owner_id = auth.uid() and id = reference_source and role <> 'metadata')
    or coalesce(length(trim(style_instructions)),0) not between 1 and 6000 or jsonb_typeof(style_metadata) is distinct from 'object' then raise exception 'Invalid continuation guide'; end if;
  insert into public.style_profiles(id,owner_id,name,instructions,inference)
    values (new_profile,auth.uid(),left(novel_title,85) || ' / reading guide ' || left(new_profile::text,8),trim(style_instructions),style_metadata);
  update public.novels set style_profile_id = new_profile where owner_id = auth.uid() and id = novel_key;
  return new_profile;
end;
$$;