alter table public.book_translation_settings
  add column translation_model text check (translation_model is null or length(translation_model) between 1 and 100),
  add column chat_model text check (chat_model is null or length(chat_model) between 1 and 100);

create function public.set_reader_models(target_book text, expected_revision integer, translation_choice text default null, chat_choice text default null) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation',0));
  update public.book_translation_settings set translation_model = nullif(trim(translation_choice),''), chat_model = nullif(trim(chat_choice),''), revision = revision + 1
    where owner_id = auth.uid() and book_id = target_book and revision = expected_revision;
  if not found then raise exception 'Translation settings changed. Reload before saving models' using errcode = '40001'; end if;
end;
$$;
revoke all on function public.set_reader_models(text,integer,text,text) from public,anon;
grant execute on function public.set_reader_models(text,integer,text,text) to authenticated;