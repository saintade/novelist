create function public.sync_web_catalog_fields() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.format = 'WEB' and new.catalog_metadata is distinct from old.catalog_metadata then
    new.genre := coalesce(nullif(new.catalog_metadata #>> '{inspection,genres,0}', ''), new.genre);
    new.language := coalesce(nullif(new.catalog_metadata->>'sourceLanguage', ''), new.language);
  end if;
  return new;
end;
$$;
create trigger sync_web_catalog before update of catalog_metadata on public.books
for each row execute function public.sync_web_catalog_fields();