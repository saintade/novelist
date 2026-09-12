alter table public.novel_sources add column contents_data jsonb not null default '{}'
  check (jsonb_typeof(contents_data) = 'object');

create function public.save_source_contents(target_book text, source_url text, contents jsonb) returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  target public.books%rowtype;
  source public.novel_sources%rowtype;
  previous_count integer;
  incoming_count integer;
begin
  select * into target from public.books where owner_id = auth.uid() and id = target_book;
  if not found then raise exception 'Book not found' using errcode = 'P0002'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target.novel_id::text, 0));
  select * into source from public.novel_sources where owner_id = auth.uid() and novel_id = target.novel_id
    and (url = source_url or contents_data->>'url' = source_url
      or (book_id = target.id and source_url = target.catalog_metadata->>'canonicalUrl'))
    order by (url = source_url) desc, created_at limit 1 for update;
  if not found or source.role = 'metadata' then raise exception 'Reading source not found' using errcode = 'P0002'; end if;
  if coalesce(jsonb_typeof(contents->'chapters'), '') <> 'array' or coalesce(contents->>'url', '') !~ '^https?://' then
    raise exception 'Invalid discovered contents';
  end if;
  incoming_count := jsonb_array_length(contents->'chapters');
  previous_count := jsonb_array_length(coalesce(source.contents_data->'chapters', '[]'::jsonb));
  if source.book_id = target.id then
    previous_count := greatest(previous_count, jsonb_array_length(coalesce(target.catalog_metadata->'contents'->'chapters', '[]'::jsonb)));
  end if;
  if incoming_count < previous_count then return false; end if;
  update public.novel_sources set contents_data = contents where owner_id = auth.uid() and id = source.id;
  if target.format = 'WEB' and source.book_id = target.id and source.role = 'original' then
    update public.books set catalog_metadata = jsonb_set(catalog_metadata, '{contents}', contents)
      where owner_id = auth.uid() and id = target.id;
  end if;
  return true;
end;
$$;
revoke all on function public.save_source_contents(text, text, jsonb) from public, anon;
grant execute on function public.save_source_contents(text, text, jsonb) to authenticated;

create function public.prevent_duplicate_web_source() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare source_key text;
begin
  if new.format <> 'WEB' then return new; end if;
  source_key := coalesce(new.catalog_metadata->>'canonicalUrl', new.source_url);
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text || source_key, 0));
  if exists (select 1 from public.books where owner_id = new.owner_id and id <> new.id
      and (source_url in (new.source_url, source_key) or catalog_metadata->>'canonicalUrl' in (new.source_url, source_key)))
    or exists (select 1 from public.novel_sources where owner_id = new.owner_id
      and novel_id <> new.novel_id and (url in (new.source_url, source_key) or contents_data->>'url' in (new.source_url, source_key))) then
    raise exception 'This source is already in the library' using errcode = '23505';
  end if;
  return new;
end;
$$;
create trigger prevent_duplicate_web_source before insert on public.books
  for each row execute function public.prevent_duplicate_web_source();