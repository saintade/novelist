create function public.inherit_original_source_inventory() returns trigger
language plpgsql security invoker set search_path = '' as $$
declare contents jsonb;
begin
  if new.role = 'original' and new.book_id is not null and not (new.contents_data ? 'chapters') then
    select catalog_metadata->'contents' into contents from public.books
      where owner_id = new.owner_id and id = new.book_id and novel_id = new.novel_id and format = 'WEB';
    if jsonb_typeof(contents->'chapters') = 'array' then new.contents_data := contents; end if;
  end if;
  return new;
end;
$$;
create trigger inherit_original_source_inventory before insert or update of book_id on public.novel_sources
  for each row execute function public.inherit_original_source_inventory();

update public.novel_sources source set contents_data = book.catalog_metadata->'contents'
from public.books book
where source.owner_id = book.owner_id and source.book_id = book.id and source.novel_id = book.novel_id
  and source.role = 'original' and book.format = 'WEB' and not (source.contents_data ? 'chapters')
  and jsonb_typeof(book.catalog_metadata->'contents'->'chapters') = 'array';