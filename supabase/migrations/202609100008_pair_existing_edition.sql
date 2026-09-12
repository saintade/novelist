alter table public.novel_sources add column identification_id uuid;
alter table public.novel_sources add constraint sources_identification_fk
  foreign key (owner_id, identification_id) references public.page_identifications (owner_id, id)
  on delete set null (identification_id);

create function public.pair_identified_edition(
  target_book text,
  identification uuid,
  reviewed_label text,
  reviewed_language text,
  source_role text
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  target public.books%rowtype;
  captured public.page_identifications%rowtype;
  linked public.novel_sources%rowtype;
  canonical_url text;
  was_paired boolean;
begin
  if auth.uid() is null then raise exception 'A library session is required'; end if;
  if coalesce(length(trim(reviewed_label)), 0) not between 1 and 200
    or coalesce(length(trim(reviewed_language)), 0) not between 2 and 35
    or coalesce(source_role, '') not in ('original', 'reference') then
    raise exception 'Review the edition label, language and role';
  end if;
  select * into target from public.books
    where owner_id = auth.uid() and id = target_book and import_state = 'ready';
  if not found then raise exception 'Book not found in this library' using errcode = 'P0002'; end if;
  select * into captured from public.page_identifications
    where owner_id = auth.uid() and id = identification;
  if not found then raise exception 'Identification not found in this library' using errcode = 'P0002'; end if;
  canonical_url := coalesce(nullif(captured.metadata->>'indexUrl', ''), captured.source_url);
  if canonical_url !~ '^https?://' then raise exception 'Invalid edition URL'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || canonical_url, 0));
  if exists (select 1 from public.novel_sources where owner_id = auth.uid()
      and novel_id <> target.novel_id and url in (canonical_url, captured.source_url))
    or exists (select 1 from public.books where owner_id = auth.uid() and novel_id <> target.novel_id
      and (source_url in (canonical_url, captured.source_url)
        or catalog_metadata->>'canonicalUrl' in (canonical_url, captured.source_url))) then
    raise exception 'This source is already linked to another novel' using errcode = '23505';
  end if;
  select * into linked from public.novel_sources where owner_id = auth.uid()
    and novel_id = target.novel_id and url in (canonical_url, captured.source_url)
    order by created_at, id limit 1;
  was_paired := found;
  if not was_paired then
    insert into public.novel_sources (owner_id, novel_id, label, url, language, role, identification_id)
    values (auth.uid(), target.novel_id, trim(reviewed_label), canonical_url,
      trim(reviewed_language), source_role, captured.id) returning * into linked;
  end if;
  update public.novels set aliases = array(
    select distinct trim(alias) from unnest(aliases || array[captured.title, captured.metadata->>'originalTitle']) as alias
    where alias is not null and trim(alias) <> ''
  ) where owner_id = auth.uid() and id = target.novel_id;
  return jsonb_build_object('bookId', target.id, 'novelId', target.novel_id,
    'sourceId', linked.id, 'url', linked.url, 'alreadyPaired', was_paired);
end;
$$;
revoke all on function public.pair_identified_edition(text, uuid, text, text, text) from public, anon;
grant execute on function public.pair_identified_edition(text, uuid, text, text, text) to authenticated;