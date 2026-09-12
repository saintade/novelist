alter table public.novel_sources add column url_aliases jsonb not null default '{}'
  check (jsonb_typeof(url_aliases) = 'object');

create function public.canonical_source_contents(contents jsonb, aliases jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare chapters jsonb; numbered integer;
begin
  if jsonb_typeof(contents->'chapters') is distinct from 'array' then return contents; end if;
  select coalesce(jsonb_agg(chapter order by first_position), '[]'::jsonb) into chapters
  from (
    select distinct on (canonical_url)
      jsonb_set(chapter, '{url}', to_jsonb(canonical_url)) as chapter,
      min(position) over (partition by canonical_url) as first_position
    from (
      select chapter, position, coalesce(aliases->>(chapter->>'url'), chapter->>'url') as canonical_url
      from jsonb_array_elements(contents->'chapters') with ordinality as entries(chapter, position)
    ) mapped
    order by canonical_url, (chapter->>'url' = canonical_url) desc, position
  ) unique_chapters;
  select count(distinct chapter->>'number') into numbered from jsonb_array_elements(chapters) as chapter;
  return contents || jsonb_build_object('chapters', chapters, 'foundCount', jsonb_array_length(chapters), 'numberedCount', numbered);
end;
$$;

create function public.record_source_chapter_alias(target_source uuid, requested_url text, canonical_url text) returns void
language plpgsql security invoker set search_path = '' as $$
declare source public.novel_sources%rowtype; aliases jsonb; contents jsonb; novel_key uuid;
begin
  select novel_id into novel_key from public.novel_sources where owner_id = auth.uid() and id = target_source;
  if not found then raise exception 'Reading source not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || novel_key::text, 0));
  select * into source from public.novel_sources where owner_id = auth.uid() and id = target_source for update;
  if source.role = 'metadata' or requested_url = canonical_url
    or length(requested_url) > 2048 or length(canonical_url) > 2048
    or regexp_replace(requested_url, '\.html?($|[?#])', '\1') <> regexp_replace(canonical_url, '\.html?($|[?#])', '\1')
    or source.url_aliases ? canonical_url then raise exception 'Invalid chapter alias'; end if;
  if not exists (select 1 from jsonb_array_elements(source.contents_data->'chapters') as chapter where chapter->>'url' = canonical_url)
    or (source.url_aliases->>requested_url is distinct from canonical_url and not exists (select 1 from jsonb_array_elements(source.contents_data->'chapters') as chapter where chapter->>'url' = requested_url)) then
    raise exception 'Both chapter URLs must belong to this source inventory';
  end if;
  aliases := source.url_aliases || jsonb_build_object(requested_url, canonical_url);
  contents := public.canonical_source_contents(source.contents_data, aliases);
  update public.novel_sources set url_aliases = aliases, contents_data = contents where owner_id = auth.uid() and id = target_source;
  if source.role = 'original' and source.book_id is not null then
    update public.books set catalog_metadata = jsonb_set(catalog_metadata, '{contents}', contents)
      where owner_id = auth.uid() and id = source.book_id and format = 'WEB';
  end if;
  update public.source_reading_progress set chapter_url = canonical_url
    where owner_id = auth.uid() and source_id = target_source and chapter_url = requested_url;
end;
$$;
revoke all on function public.record_source_chapter_alias(uuid,text,text) from public, anon;
grant execute on function public.record_source_chapter_alias(uuid,text,text) to authenticated;