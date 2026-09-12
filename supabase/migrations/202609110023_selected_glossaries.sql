alter table public.book_translation_settings add column glossary_sources jsonb not null default '[]'::jsonb
  check (jsonb_typeof(glossary_sources) = 'array' and jsonb_array_length(glossary_sources) <= 32);

create function public.list_library_glossaries() returns table(book_id text, title text, source_language text, target_language text, term_count bigint, categories text[])
language sql stable security invoker set search_path = '' as $$
  select book.id, book.title, term.source_language, term.target_language, count(*), array_agg(distinct term.category order by term.category)
  from public.books book join public.glossary_entries term on term.owner_id = book.owner_id and term.novel_id = book.novel_id
  where book.owner_id = auth.uid() and term.scope = 'novel' and term.status = 'approved'
  group by book.id, book.title, term.source_language, term.target_language order by book.title, term.source_language, term.target_language;
$$;
revoke all on function public.list_library_glossaries() from public,anon;
grant execute on function public.list_library_glossaries() to authenticated;

create function public.set_glossary_sources(target_book text, expected_revision integer, selected_sources jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
declare preferences public.book_translation_settings%rowtype; selection jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  select * into preferences from public.book_translation_settings where owner_id = auth.uid() and book_id = target_book and revision = expected_revision for update;
  if not found then raise exception 'Translation settings changed. Reload before saving glossary sources' using errcode = '40001'; end if;
  if jsonb_typeof(selected_sources) is distinct from 'array' or jsonb_array_length(selected_sources) > 32 then raise exception 'Invalid glossary selection'; end if;
  for selection in select value from jsonb_array_elements(selected_sources) loop
    if selection->>'bookId' = target_book or not exists (
      select 1 from public.list_library_glossaries() glossary where glossary.book_id = selection->>'bookId'
        and glossary.source_language = selection->>'sourceLanguage' and glossary.target_language = selection->>'targetLanguage'
    ) then raise exception 'Choose an approved glossary from another book in this library'; end if;
    if lower(split_part(replace(selection->>'targetLanguage','_','-'),'-',1)) <> lower(split_part(replace(preferences.target_language,'_','-'),'-',1)) then
      raise exception 'The glossary target language must match the translation language';
    end if;
  end loop;
  update public.book_translation_settings set glossary_sources = selected_sources, revision = revision + 1 where owner_id = auth.uid() and book_id = target_book;
end;
$$;
revoke all on function public.set_glossary_sources(text,integer,jsonb) from public,anon;
grant execute on function public.set_glossary_sources(text,integer,jsonb) to authenticated;