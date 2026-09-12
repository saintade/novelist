create or replace function public.prepare_novel_for_book() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if new.novel_id is null then
    new.novel_id := md5(new.owner_id::text || ':' || new.id)::uuid;
  end if;
  insert into public.novels (id, owner_id, title, author)
  values (new.novel_id, new.owner_id, new.title, new.author)
  on conflict (owner_id, id) do nothing;
  return new;
end;
$$;

alter table public.glossary_entries drop constraint glossary_entries_owner_id_run_id_fkey;
alter table public.glossary_entries add constraint glossary_entries_run_fk
  foreign key (owner_id, run_id) references public.translation_runs (owner_id, id) on delete set null (run_id);