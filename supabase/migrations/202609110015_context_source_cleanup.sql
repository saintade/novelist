create function public.detach_deleted_context_source() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  update public.book_translation_settings set
    main_source_id = case when main_source_id = old.id then null else main_source_id end,
    reference_source_id = case when reference_source_id = old.id then null else reference_source_id end,
    metadata_source_id = case when metadata_source_id = old.id then null else metadata_source_id end,
    revision = revision + 1
    where owner_id = old.owner_id and (main_source_id = old.id or reference_source_id = old.id or metadata_source_id = old.id);
  update public.novels novel set style_profile_id = null
    where novel.owner_id = old.owner_id and exists (
      select 1 from public.style_profiles profile where profile.owner_id = novel.owner_id and profile.id = novel.style_profile_id
        and profile.inference->>'kind' = 'continuation' and profile.inference->>'referenceSourceId' = old.id::text
    );
  return old;
end;
$$;
create trigger detach_context_source before delete on public.novel_sources
  for each row execute function public.detach_deleted_context_source();