alter table public.book_translation_settings
  add column context_tokens integer not null default 128000 check (context_tokens between 32000 and 128000),
  add column recent_chapters integer not null default 3 check (recent_chapters between 1 and 10),
  add column guide_auto_update boolean not null default false,
  add column guide_interval integer not null default 5 check (guide_interval between 1 and 100),
  add column guide_feedback text not null default '' check (length(guide_feedback) <= 2000),
  add column guide_chapters_since_update integer not null default 0 check (guide_chapters_since_update >= 0);

create function public.set_context_preferences(target_book text, expected_revision integer, token_budget integer, recent_count integer, auto_guide boolean, update_interval integer, feedback text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  update public.book_translation_settings set context_tokens = token_budget, recent_chapters = recent_count,
    guide_auto_update = auto_guide, guide_interval = update_interval, guide_feedback = trim(feedback), revision = revision + 1
    where owner_id = auth.uid() and book_id = target_book and revision = expected_revision;
  if not found then raise exception 'Translation settings changed. Refresh and retry' using errcode = '40001'; end if;
end;
$$;
revoke all on function public.set_context_preferences(text,integer,integer,integer,boolean,integer,text) from public,anon;
grant execute on function public.set_context_preferences(text,integer,integer,integer,boolean,integer,text) to authenticated;

create function public.count_translated_chapter() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.kind = 'chapter' and not (new.context ? 'manualEdit') and not exists (
    select 1 from public.book_translation_previews previous where previous.owner_id = new.owner_id and previous.book_id = new.book_id
      and previous.kind = 'chapter' and previous.source_key = new.source_key and previous.target_language = new.target_language and previous.id <> new.id
  ) then
    update public.book_translation_settings set guide_chapters_since_update = guide_chapters_since_update + 1
      where owner_id = new.owner_id and book_id = new.book_id;
  end if;
  return new;
end;
$$;
create trigger count_translation_for_guide after insert on public.book_translation_previews
  for each row execute function public.count_translated_chapter();

create function public.reset_reading_guide_counter() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.style_profile_id is distinct from old.style_profile_id and exists (
    select 1 from public.style_profiles where owner_id = new.owner_id and id = new.style_profile_id and inference->>'kind' = 'continuation'
  ) then
    update public.book_translation_settings settings set guide_chapters_since_update = 0
      from public.books book where settings.owner_id = new.owner_id and book.owner_id = settings.owner_id and book.id = settings.book_id and book.novel_id = new.id;
  end if;
  return new;
end;
$$;
create trigger reset_guide_counter after update of style_profile_id on public.novels
  for each row execute function public.reset_reading_guide_counter();