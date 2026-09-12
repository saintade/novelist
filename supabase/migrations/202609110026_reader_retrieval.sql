create table public.reader_search_documents (
  owner_id uuid not null default auth.uid(),
  id uuid not null default gen_random_uuid(),
  book_id text not null,
  source_id uuid,
  source_key text not null,
  variant text not null,
  chapter_position integer not null check (chapter_position >= 0),
  title text not null,
  version_id uuid,
  content_hash text not null,
  chunk_count integer not null default 0,
  search_bytes bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key(owner_id,id),
  unique(owner_id,book_id,source_key,variant),
  foreign key(owner_id,book_id) references public.books(owner_id,id) on delete cascade,
  foreign key(owner_id,source_id) references public.novel_sources(owner_id,id) on delete cascade,
  foreign key(owner_id,version_id) references public.book_translation_previews(owner_id,id) on delete cascade
);
create table public.reader_search_chunks (
  owner_id uuid not null default auth.uid(),
  document_id uuid not null,
  chunk_index integer not null,
  start_offset integer not null,
  end_offset integer not null,
  terms tsvector not null,
  primary key(owner_id,document_id,chunk_index),
  foreign key(owner_id,document_id) references public.reader_search_documents(owner_id,id) on delete cascade,
  check (start_offset >= 0 and end_offset > start_offset)
);
create index reader_search_terms on public.reader_search_chunks using gin(terms);
alter table public.reader_search_documents enable row level security;
alter table public.reader_search_chunks enable row level security;
create policy "Own reading search documents" on public.reader_search_documents for all to authenticated using(owner_id = (select auth.uid())) with check(owner_id = (select auth.uid()));
create policy "Own reading search chunks" on public.reader_search_chunks for all to authenticated using(owner_id = (select auth.uid())) with check(owner_id = (select auth.uid()));
grant select,insert,update,delete on public.reader_search_documents,public.reader_search_chunks to authenticated;

create function public.index_reader_document(target_book text, reading_source uuid, chapter_key text, variant_key text, chapter_index integer, chapter_title text, translation_version uuid, fingerprint text, chunks jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare document_key uuid; chunk jsonb;
begin
  if not exists(select 1 from public.books where owner_id = auth.uid() and id = target_book) then raise exception 'Book not found'; end if;
  if reading_source is not null and not exists(select 1 from public.novel_sources source join public.books book on book.owner_id = source.owner_id and book.novel_id = source.novel_id where source.owner_id = auth.uid() and source.id = reading_source and book.id = target_book and source.role <> 'metadata') then raise exception 'Reading source does not belong to this book'; end if;
  if translation_version is not null and not exists(select 1 from public.book_translation_previews where owner_id = auth.uid() and id = translation_version and book_id = target_book and source_key = chapter_key and kind = 'chapter') then raise exception 'Translation does not belong to this chapter'; end if;
  if length(fingerprint) <> 64 or length(chapter_title) > 1000 or length(variant_key) > 50 or jsonb_typeof(chunks) is distinct from 'array' or jsonb_array_length(chunks) > 1024 then raise exception 'Invalid search document'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || chapter_key || variant_key || ':reader-index',0));
  insert into public.reader_search_documents(book_id,source_id,source_key,variant,chapter_position,title,version_id,content_hash)
    values(target_book,reading_source,chapter_key,variant_key,chapter_index,chapter_title,translation_version,fingerprint)
    on conflict(owner_id,book_id,source_key,variant) do update set source_id = excluded.source_id,chapter_position = excluded.chapter_position,title = excluded.title,version_id = excluded.version_id,content_hash = excluded.content_hash,updated_at = now()
    returning id into document_key;
  delete from public.reader_search_chunks where owner_id = auth.uid() and document_id = document_key;
  for chunk in select value from jsonb_array_elements(chunks) loop
    if length(chunk->>'text') > 12000 then raise exception 'Search chunk is too large'; end if;
    insert into public.reader_search_chunks(document_id,chunk_index,start_offset,end_offset,terms)
      values(document_key,(chunk->>'index')::integer,(chunk->>'start')::integer,(chunk->>'end')::integer,
        setweight(to_tsvector('english'::regconfig,chapter_title || ' Chapter ' || (chapter_index + 1)::text),'A') || setweight(to_tsvector('english'::regconfig,chunk->>'text'),'B'));
  end loop;
  update public.reader_search_documents set chunk_count = jsonb_array_length(chunks), search_bytes = coalesce((select sum(pg_column_size(terms) + 24) from public.reader_search_chunks where owner_id = auth.uid() and document_id = document_key),0)
    where owner_id = auth.uid() and id = document_key;
  return document_key;
end;
$$;

create function public.search_reader_passages(document_ids uuid[], query_terms text[]) returns table(document_id uuid,chunk_index integer,start_offset integer,end_offset integer,rank real)
language sql stable security invoker set search_path = '' as $$
  with query as (select websearch_to_tsquery('english'::regconfig,array_to_string(query_terms[1:40],' OR ')) as terms)
  select chunk.document_id,chunk.chunk_index,chunk.start_offset,chunk.end_offset,ts_rank_cd(chunk.terms,query.terms) as rank
  from public.reader_search_chunks chunk cross join query
  where chunk.owner_id = auth.uid() and chunk.document_id = any(document_ids) and chunk.terms @@ query.terms
  order by rank desc,chunk.document_id,chunk.chunk_index limit 12;
$$;
revoke all on function public.index_reader_document(text,uuid,text,text,integer,text,uuid,text,jsonb), public.search_reader_passages(uuid[],text[]) from public,anon;
grant execute on function public.index_reader_document(text,uuid,text,text,integer,text,uuid,text,jsonb), public.search_reader_passages(uuid[],text[]) to authenticated;

alter table public.reader_chat_turns drop constraint reader_chat_turns_scope_check;
alter table public.reader_chat_turns add constraint reader_chat_turns_scope_check check (scope in ('chapter','recent','retrieval'));