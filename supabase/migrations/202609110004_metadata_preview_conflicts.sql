create or replace function public.apply_book_metadata(preview_id uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  preview public.book_translation_previews%rowtype;
  book public.books%rowtype;
begin
  select * into preview from public.book_translation_previews
    where owner_id = auth.uid() and id = preview_id and kind = 'metadata';
  if not found then raise exception 'Metadata preview not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || preview.book_id || ':translation', 0));
  select * into preview from public.book_translation_previews
    where owner_id = auth.uid() and id = preview_id and kind = 'metadata' for update;
  if not found then raise exception 'Metadata preview not found'; end if;
  if preview.applied_at is not null then
    raise exception 'Metadata preview already applied' using errcode = '40001';
  end if;
  select * into book from public.books
    where owner_id = auth.uid() and id = preview.book_id for update;
  if not found then raise exception 'Book not found'; end if;
  if book.title is distinct from preview.context->>'originalTitle'
    or book.description is distinct from preview.context->>'originalDescription'
    or book.author is distinct from preview.context->>'originalAuthor'
    or book.source_cover_url is distinct from preview.context->>'originalCoverUrl'
    or not exists (
      select 1 from public.book_translation_settings
      where owner_id = auth.uid() and book_id = preview.book_id
        and revision = (preview.context->>'settingsRevision')::integer
    ) then
    raise exception 'Book or preferences changed. Create a new preview' using errcode = '40001';
  end if;
  if coalesce(length(trim(preview.result->>'title')), 0) not between 1 and 500
    or coalesce(length(preview.result->>'synopsis'), 0) > 48000 then
    raise exception 'Invalid metadata preview';
  end if;
  update public.books set title = preview.result->>'title',
    description = coalesce(preview.result->>'synopsis', ''),
    author = coalesce(nullif(preview.result->>'author', ''), author),
    source_cover_url = coalesce(nullif(preview.context->>'coverUrl', ''), source_cover_url)
    where owner_id = auth.uid() and id = preview.book_id;
  update public.book_translation_previews set applied_at = now()
    where owner_id = auth.uid() and id = preview_id;
end;
$$;