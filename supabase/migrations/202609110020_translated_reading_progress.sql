create table public.source_translation_progress (
  owner_id uuid not null default auth.uid(),
  source_id uuid not null,
  target_language text not null,
  chapter_url text not null,
  fraction double precision not null check (fraction between 0 and 1),
  translation_version uuid,
  updated_at timestamptz not null default now(),
  primary key (owner_id,source_id,target_language),
  foreign key (owner_id,source_id) references public.novel_sources(owner_id,id) on delete cascade,
  foreign key (owner_id,translation_version) references public.book_translation_previews(owner_id,id) on delete set null (translation_version)
);
alter table public.source_translation_progress enable row level security;
create policy "Own translated reading positions" on public.source_translation_progress for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select,insert,update,delete on public.source_translation_progress to authenticated;

alter table public.reading_progress
  add column source_id uuid,
  add column source_chapter_url text,
  add column target_language text,
  add column translation_version uuid;
alter table public.reading_progress add constraint reading_progress_source_fk foreign key (owner_id,source_id)
  references public.novel_sources(owner_id,id) on delete set null (source_id);
alter table public.reading_progress add constraint reading_progress_translation_fk foreign key (owner_id,translation_version)
  references public.book_translation_previews(owner_id,id) on delete set null (translation_version);

create function public.save_source_reading_position(target_source uuid, chapter_url text, fraction double precision, language text default null, version_id uuid default null, observed_at timestamptz default now(), finished boolean default false) returns void
language plpgsql security invoker set search_path = '' as $$
declare selected_source public.novel_sources%rowtype; chapter_index integer;
begin
  select * into selected_source from public.novel_sources where owner_id = auth.uid() and id = target_source and role <> 'metadata';
  if not found then raise exception 'Reading source not found' using errcode = 'P0002'; end if;
  if fraction is null or fraction < 0 or fraction > 1 or observed_at is null or observed_at > now() + interval '5 minutes' then raise exception 'Invalid reading position'; end if;
  select (position - 1)::integer into chapter_index from jsonb_array_elements(coalesce(selected_source.contents_data->'chapters','[]'::jsonb)) with ordinality as chapter(value,position)
    where chapter.value->>'url' = chapter_url limit 1;
  if chapter_index is null then raise exception 'Choose a chapter from the saved inventory'; end if;
  if language is not null and not exists (
    select 1 from public.book_translation_previews where owner_id = auth.uid() and id = version_id and kind = 'chapter'
      and source_key = chapter_url and target_language = language and context->'source'->>'sourceId' = target_source::text
  ) then raise exception 'Translation version does not match this chapter'; end if;
  if language is null then
    insert into public.source_reading_progress(source_id,chapter_url,fraction,updated_at)
      values (target_source,chapter_url,fraction,observed_at)
      on conflict (owner_id,source_id) do update set chapter_url = excluded.chapter_url,fraction = excluded.fraction,updated_at = excluded.updated_at
        where public.source_reading_progress.updated_at <= excluded.updated_at;
  else
    insert into public.source_translation_progress(source_id,target_language,chapter_url,fraction,translation_version,updated_at)
      values (target_source,language,chapter_url,fraction,version_id,observed_at)
      on conflict (owner_id,source_id,target_language) do update set chapter_url = excluded.chapter_url,fraction = excluded.fraction,translation_version = excluded.translation_version,updated_at = excluded.updated_at
        where public.source_translation_progress.updated_at <= excluded.updated_at;
  end if;
  if selected_source.book_id is not null then
    insert into public.reading_progress(book_id,chapter,fraction,status,last_read_at,source_id,source_chapter_url,target_language,translation_version)
      values (selected_source.book_id,chapter_index,fraction,case when finished then 'finished' else 'reading' end,observed_at,target_source,chapter_url,language,case when language is null then null else version_id end)
      on conflict (owner_id,book_id) do update set chapter = excluded.chapter,fraction = excluded.fraction,status = excluded.status,last_read_at = excluded.last_read_at,
        source_id = excluded.source_id,source_chapter_url = excluded.source_chapter_url,target_language = excluded.target_language,translation_version = excluded.translation_version
        where public.reading_progress.last_read_at is null or public.reading_progress.last_read_at <= excluded.last_read_at;
  end if;
end;
$$;
revoke all on function public.save_source_reading_position(uuid,text,double precision,text,uuid,timestamptz,boolean) from public,anon;
grant execute on function public.save_source_reading_position(uuid,text,double precision,text,uuid,timestamptz,boolean) to authenticated;