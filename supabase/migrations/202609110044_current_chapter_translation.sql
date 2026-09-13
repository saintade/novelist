begin;

lock table public.book_translation_previews in share row exclusive mode;

create temporary table translation_replacements on commit drop as
select owner_id,id as previous_id,current_id from (
  select owner_id,id,first_value(id) over (
    partition by owner_id,book_id,source_key,target_language
    order by created_at desc,id desc
  ) as current_id
  from public.book_translation_previews where kind = 'chapter' and source_key is not null
) ranked where id <> current_id;

update public.source_translation_progress progress set translation_version = replacement.current_id
  from translation_replacements replacement
  where progress.owner_id = replacement.owner_id and progress.translation_version = replacement.previous_id;
update public.reading_progress progress set translation_version = replacement.current_id
  from translation_replacements replacement
  where progress.owner_id = replacement.owner_id and progress.translation_version = replacement.previous_id;
update public.translation_batch_chapters chapter set preview_id = replacement.current_id
  from translation_replacements replacement
  where chapter.owner_id = replacement.owner_id and chapter.preview_id = replacement.previous_id;
delete from public.reader_search_documents document using translation_replacements replacement
  where document.owner_id = replacement.owner_id and document.version_id = replacement.previous_id;
delete from public.book_translation_previews preview using translation_replacements replacement
  where preview.owner_id = replacement.owner_id and preview.id = replacement.previous_id;

create unique index book_translation_previews_current_chapter
  on public.book_translation_previews(owner_id,book_id,source_key,target_language) where kind = 'chapter';

alter table public.source_translation_progress drop constraint source_translation_progress_owner_id_translation_version_fkey;
alter table public.source_translation_progress add constraint source_translation_progress_owner_id_translation_version_fkey
  foreign key (owner_id,translation_version) references public.book_translation_previews(owner_id,id)
  on update cascade on delete set null (translation_version);
alter table public.reading_progress drop constraint reading_progress_translation_fk;
alter table public.reading_progress add constraint reading_progress_translation_fk
  foreign key (owner_id,translation_version) references public.book_translation_previews(owner_id,id)
  on update cascade on delete set null (translation_version);
alter table public.translation_batch_chapters drop constraint translation_batch_chapters_owner_id_preview_id_fkey;
alter table public.translation_batch_chapters add constraint translation_batch_chapters_owner_id_preview_id_fkey
  foreign key (owner_id,preview_id) references public.book_translation_previews(owner_id,id)
  on update cascade on delete set null (preview_id);
alter table public.reader_search_documents drop constraint reader_search_documents_owner_id_version_id_fkey;
alter table public.reader_search_documents add constraint reader_search_documents_owner_id_version_id_fkey
  foreign key (owner_id,version_id) references public.book_translation_previews(owner_id,id)
  on update cascade on delete cascade;

create function public.invalidate_replaced_translation_search() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if old.kind = 'chapter' and (old.id is distinct from new.id or old.result is distinct from new.result) then
    delete from public.reader_search_documents
      where owner_id = new.owner_id and version_id in (old.id,new.id);
  end if;
  return new;
end;
$$;
revoke all on function public.invalidate_replaced_translation_search() from public,anon,authenticated;
create trigger invalidate_replaced_translation_search after update of id,result on public.book_translation_previews
  for each row execute function public.invalidate_replaced_translation_search();

create or replace function public.complete_chapter_translation(target_book text, chapter_key text, expected_revision integer, translation_model text, snapshot jsonb, draft jsonb, consumed_input integer, consumed_output integer) returns jsonb
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
    on conflict (owner_id,book_id,source_key,target_language) where kind = 'chapter' do update
      set id = excluded.id,result = excluded.result,context = excluded.context,model = excluded.model,
        input_tokens = excluded.input_tokens,output_tokens = excluded.output_tokens,
        applied_at = null,created_at = excluded.created_at
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
revoke all on function public.complete_chapter_translation(text,text,integer,text,jsonb,jsonb,integer,integer) from public,anon;
grant execute on function public.complete_chapter_translation(text,text,integer,text,jsonb,jsonb,integer,integer) to authenticated;

create or replace function public.save_translation_term_edit(preview_id uuid, source_spelling text, previous_target text, preferred_target text, preferred_category text, preferred_scope text, preferred_sense text, preferred_aliases text[], edited_result jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare preview public.book_translation_previews%rowtype; novel_key uuid; original_term jsonb; expected_terms jsonb; entry_key uuid; new_preview uuid; selected_source_language text;
begin
  select * into preview from public.book_translation_previews where owner_id = auth.uid() and id = preview_id and kind = 'chapter';
  if not found then raise exception 'Translation changed. Reload the chapter before editing its terms' using errcode = '40001'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || preview.book_id || ':translation',0));
  select * into preview from public.book_translation_previews where owner_id = auth.uid() and id = preview_id and kind = 'chapter';
  if not found then raise exception 'Translation changed. Reload the chapter before editing its terms' using errcode = '40001'; end if;
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
      'manual edit',0,0)
    on conflict (owner_id,book_id,source_key,target_language) where kind = 'chapter' do update
      set id = excluded.id,result = excluded.result,context = excluded.context,model = excluded.model,
        input_tokens = excluded.input_tokens,output_tokens = excluded.output_tokens,
        applied_at = null,created_at = excluded.created_at
    returning id into new_preview;
  return new_preview;
end;
$$;
revoke all on function public.save_translation_term_edit(uuid,text,text,text,text,text,text,text[],jsonb) from public,anon;
grant execute on function public.save_translation_term_edit(uuid,text,text,text,text,text,text,text[],jsonb) to authenticated;

commit;