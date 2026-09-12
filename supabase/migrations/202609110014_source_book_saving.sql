create or replace function public.attach_novelupdates(target_book text, catalog_url text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare novel_key uuid; source_key uuid; identification_key uuid; normalized_url text;
begin
  if catalog_url !~ '^https?://(www\.)?novelupdates\.com/series/[^/?#]+/?$' then
    raise exception 'Use a Novel Updates series URL';
  end if;
  normalized_url := 'https://www.novelupdates.com/series/' || split_part(split_part(catalog_url,'/series/',2),'/',1) || '/';
  select novel_id into novel_key from public.books where owner_id = auth.uid() and id = target_book;
  if not found then raise exception 'Book not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  select id into identification_key from public.page_identifications where owner_id = auth.uid()
    and rtrim(source_url,'/') = rtrim(normalized_url,'/') order by created_at desc limit 1;
  select id into source_key from public.novel_sources where owner_id = auth.uid() and novel_id = novel_key
    and rtrim(url,'/') = rtrim(normalized_url,'/') and role = 'metadata' order by created_at limit 1;
  if source_key is null then
    insert into public.novel_sources(novel_id,label,url,language,role,identification_id)
      values (novel_key,'Novel Updates',normalized_url,'en','metadata',identification_key) returning id into source_key;
  elsif identification_key is not null then
    update public.novel_sources set identification_id = identification_key where owner_id = auth.uid() and id = source_key;
  end if;
  insert into public.book_translation_settings(book_id,main_source_id,metadata_source_id)
    values (target_book,(select id from public.novel_sources where owner_id = auth.uid() and book_id = target_book and role <> 'metadata'),source_key)
    on conflict (owner_id,book_id) do update set metadata_source_id = excluded.metadata_source_id, revision = public.book_translation_settings.revision + 1;
  return source_key;
end;
$$;
revoke all on function public.attach_novelupdates(text,text) from public, anon;
grant execute on function public.attach_novelupdates(text,text) to authenticated;

create or replace function public.add_source_book(identification uuid, reviewed_title text, reviewed_author text, contents_data jsonb, reference_sources jsonb, overwrite_existing boolean default false, novel_updates_url text default null) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare captured public.page_identifications%rowtype; source public.novel_sources%rowtype; result jsonb; book_key text; source_key uuid;
begin
  if coalesce(length(trim(reviewed_title)),0) not between 1 and 500 or coalesce(length(trim(reviewed_author)),0) not between 1 and 300 then raise exception 'Review the title and author before adding this book'; end if;
  if jsonb_typeof(contents_data) is distinct from 'object' or jsonb_typeof(reference_sources) is distinct from 'array' then raise exception 'Invalid source book metadata'; end if;
  select * into captured from public.page_identifications where owner_id = auth.uid() and id = identification;
  if not found then raise exception 'Identification not found' using errcode = 'P0002'; end if;
  if captured.source_url ~ '^https?://(www\.)?novelupdates\.com/' then raise exception 'Attach Novel Updates to a reading book instead'; end if;
  select candidate.* into source from public.novel_sources candidate where candidate.owner_id = auth.uid() and candidate.role <> 'metadata'
    and (candidate.url in (captured.source_url,captured.metadata->>'indexUrl') or candidate.contents_data->>'url' in (captured.source_url,captured.metadata->>'indexUrl'))
    order by candidate.created_at limit 1;
  if found then
    book_key := coalesce(source.book_id,public.materialize_source_book(source.id));
    if contents_data <> '{}'::jsonb then perform public.save_source_contents(book_key,source.url,contents_data); end if;
    if overwrite_existing then
      update public.books set title = trim(reviewed_title), author = trim(reviewed_author), identification_id = identification,
        description = coalesce((select string_agg(value->>'text',E'\n\n') from jsonb_array_elements(coalesce(captured.metadata->'synopses','[]'::jsonb))),''),
        source_cover_url = coalesce(captured.cover_url,source_cover_url),
        catalog_metadata = catalog_metadata || jsonb_build_object('inspection',captured.metadata,'sourceLanguage',captured.source_language,'outputLanguage',captured.output_language)
        where owner_id = auth.uid() and id = book_key;
      update public.novel_sources set identification_id = identification, language = coalesce(captured.source_language,language)
        where owner_id = auth.uid() and id = source.id;
      update public.novels novel set title = trim(reviewed_title), author = trim(reviewed_author)
        from public.books book where novel.owner_id = auth.uid() and book.owner_id = novel.owner_id and book.id = book_key and novel.id = book.novel_id;
    end if;
    select jsonb_build_object('bookId',id,'novelId',novel_id,'alreadySaved',true,'updated',overwrite_existing)
      into result from public.books where owner_id = auth.uid() and id = book_key;
  else
    result := public.add_identified_novel(identification,reviewed_title,reviewed_author,contents_data,reference_sources,overwrite_existing);
    book_key := result->>'bookId';
    for source_key in select id from public.novel_sources where owner_id = auth.uid() and novel_id = (result->>'novelId')::uuid and role <> 'metadata' and book_id is null and url is not null loop
      perform public.materialize_source_book(source_key);
    end loop;
  end if;
  if novel_updates_url is not null then perform public.attach_novelupdates(book_key,novel_updates_url); end if;
  return result;
end;
$$;
revoke all on function public.add_source_book(uuid,text,text,jsonb,jsonb,boolean,text) from public, anon;
grant execute on function public.add_source_book(uuid,text,text,jsonb,jsonb,boolean,text) to authenticated;