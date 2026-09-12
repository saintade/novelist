create or replace function public.save_continuation_style(target_book text, reference_source uuid, expected_revision integer, expected_profile uuid, style_instructions text, style_metadata jsonb) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare novel_key uuid; novel_title text; selected_profile uuid; main_source uuid; new_profile uuid := gen_random_uuid();
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select book.novel_id, book.title, settings.main_source_id into novel_key, novel_title, main_source from public.books book
    join public.book_translation_settings settings on settings.owner_id = book.owner_id and settings.book_id = book.id
    where book.owner_id = auth.uid() and book.id = target_book and settings.revision = expected_revision and settings.reference_source_id is not distinct from reference_source;
  if not found then raise exception 'Translation settings changed. Update the guide again' using errcode = '40001'; end if;
  select style_profile_id into selected_profile from public.novels where owner_id = auth.uid() and id = novel_key for update;
  if selected_profile is distinct from expected_profile then raise exception 'Selected style changed. Reload before updating the guide' using errcode = '40001'; end if;
  if (reference_source is not null and not exists (select 1 from public.novel_sources where owner_id = auth.uid() and id = reference_source and role <> 'metadata'))
    or (reference_source is null and main_source is null)
    or coalesce(length(trim(style_instructions)),0) not between 1 and 6000 or jsonb_typeof(style_metadata) is distinct from 'object' then raise exception 'Invalid continuation guide'; end if;
  insert into public.style_profiles(id,owner_id,name,instructions,inference)
    values (new_profile,auth.uid(),left(novel_title,85) || ' / reading guide ' || left(new_profile::text,8),trim(style_instructions),style_metadata);
  update public.novels set style_profile_id = new_profile where owner_id = auth.uid() and id = novel_key;
  return new_profile;
end;
$$;