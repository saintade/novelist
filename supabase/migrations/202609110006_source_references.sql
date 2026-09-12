alter table public.book_translation_settings add column reference_source_id uuid;
alter table public.book_translation_settings add constraint settings_reference_source_fk
  foreign key (owner_id, reference_source_id) references public.novel_sources(owner_id, id) on delete set null (reference_source_id);
alter table public.book_translation_settings add constraint one_reference_kind check (reference_source_id is null or reference_book_id is null);

create function public.set_source_translation_settings(target_book text, target_language text, reference_book text, reference_mode text, expected_revision integer, main_source uuid, metadata_source uuid, reference_source uuid) returns void
language plpgsql security invoker set search_path = '' as $$
declare novel_key uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select novel_id into novel_key from public.books where owner_id = auth.uid() and id = target_book;
  if not found then raise exception 'Book not found'; end if;
  if reference_source is not null then
    if reference_book is not null or main_source is null or main_source = reference_source then raise exception 'Choose two different reading sources'; end if;
    if not exists (select 1 from public.novel_sources where owner_id = auth.uid() and id = reference_source and novel_id = novel_key and role <> 'metadata') then raise exception 'Choose a reference reading source for this novel'; end if;
  end if;
  update public.book_translation_settings set reference_source_id = null where owner_id = auth.uid() and book_id = target_book;
  perform public.set_book_translation_settings(target_book, target_language, reference_book, reference_mode, expected_revision, main_source, metadata_source);
  update public.book_translation_settings set reference_source_id = reference_source where owner_id = auth.uid() and book_id = target_book;
end;
$$;
revoke all on function public.set_source_translation_settings(text,text,text,text,integer,uuid,uuid,uuid) from public, anon;
grant execute on function public.set_source_translation_settings(text,text,text,text,integer,uuid,uuid,uuid) to authenticated;

create table public.source_chapter_alignments (
  owner_id uuid not null default auth.uid(),
  source_id uuid not null,
  source_url text not null,
  reference_source_id uuid not null,
  reference_urls text[] not null default '{}',
  status text not null check (status in ('proposed','confirmed','rejected')),
  method text not null check (method in ('manual','model')),
  reason text not null default '',
  updated_at timestamptz not null default now(),
  primary key (owner_id, source_id, source_url, reference_source_id),
  foreign key (owner_id, source_id, source_url) references public.source_chapters(owner_id,source_id,url) on delete cascade,
  foreign key (owner_id, reference_source_id) references public.novel_sources(owner_id,id) on delete cascade,
  check (source_id <> reference_source_id),
  check (cardinality(reference_urls) <= 20)
);
alter table public.source_chapter_alignments enable row level security;
create policy "Own source alignments" on public.source_chapter_alignments for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.source_chapter_alignments to authenticated;

create function public.review_source_alignment(target_source uuid, chapter_url text, reference_source uuid, paired_urls text[], decision text) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if decision not in ('confirmed','rejected') or cardinality(paired_urls) > 20 then raise exception 'Invalid alignment review'; end if;
  if not exists (select 1 from public.novel_sources original join public.novel_sources reference on reference.novel_id = original.novel_id and reference.owner_id = original.owner_id where original.owner_id = auth.uid() and original.id = target_source and reference.id = reference_source and original.role <> 'metadata' and reference.role <> 'metadata' and original.id <> reference.id) then raise exception 'Choose reading sources for the same novel'; end if;
  if decision = 'confirmed' and (coalesce(cardinality(paired_urls),0) = 0 or exists (select 1 from unnest(paired_urls) as paired(url) where not exists (select 1 from public.source_chapters where owner_id = auth.uid() and source_id = reference_source and url = paired.url))) then raise exception 'Download each selected reference chapter first'; end if;
  insert into public.source_chapter_alignments(source_id,source_url,reference_source_id,reference_urls,status,method)
    values (target_source,chapter_url,reference_source,case when decision = 'rejected' then '{}'::text[] else paired_urls end,decision,'manual')
    on conflict (owner_id,source_id,source_url,reference_source_id) do update set reference_urls = excluded.reference_urls, status = excluded.status, method = 'manual', reason = '', updated_at = now();
end;
$$;
revoke all on function public.review_source_alignment(uuid,text,uuid,text[],text) from public, anon;
grant execute on function public.review_source_alignment(uuid,text,uuid,text[],text) to authenticated;

create table public.source_analysis_runs (
  owner_id uuid not null default auth.uid(),
  id uuid not null default gen_random_uuid(),
  book_id text not null,
  source_id uuid not null,
  source_url text not null,
  reference_source_id uuid not null,
  model text not null,
  context jsonb not null,
  result jsonb not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (owner_id,id),
  foreign key (owner_id,book_id) references public.books(owner_id,id) on delete cascade,
  foreign key (owner_id,source_id,source_url) references public.source_chapters(owner_id,source_id,url) on delete cascade,
  foreign key (owner_id,reference_source_id) references public.novel_sources(owner_id,id) on delete cascade
);
alter table public.source_analysis_runs enable row level security;
create policy "Own source analysis" on public.source_analysis_runs for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.source_analysis_runs to authenticated;

create function public.complete_source_analysis(target_book text, target_source uuid, chapter_url text, reference_source uuid, expected_revision integer, analysis_model text, snapshot jsonb, analysis jsonb, consumed_input integer, consumed_output integer) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare novel_key uuid; selected_source_language text; selected_target_language text; analysis_id uuid; term jsonb; paired text[];
begin
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || target_book || ':translation', 0));
  select books.novel_id, settings.target_language into novel_key, selected_target_language from public.books books join public.book_translation_settings settings on settings.owner_id = books.owner_id and settings.book_id = books.id where books.owner_id = auth.uid() and books.id = target_book and settings.revision = expected_revision and settings.main_source_id = target_source and settings.reference_source_id = reference_source;
  if not found then raise exception 'Translation settings changed. Run the analysis again' using errcode = '40001'; end if;
  select language into selected_source_language from public.novel_sources where owner_id = auth.uid() and id = target_source and novel_id = novel_key and role <> 'metadata';
  if not found then raise exception 'Source not found'; end if;
  if not exists (select 1 from public.novel_sources where owner_id = auth.uid() and id = reference_source and novel_id = novel_key and role <> 'metadata') then raise exception 'Reference source not found'; end if;
  select coalesce(array_agg(match->>'url'),'{}'::text[]) into paired from jsonb_array_elements(analysis->'matches') as match;
  if cardinality(paired) > 20 or exists (select 1 from unnest(paired) as paired(url) where not exists (select 1 from public.source_chapters where owner_id = auth.uid() and source_id = reference_source and url = paired.url)) then raise exception 'Invalid reference chapters'; end if;
  insert into public.source_analysis_runs(book_id,source_id,source_url,reference_source_id,model,context,result,input_tokens,output_tokens) values (target_book,target_source,chapter_url,reference_source,analysis_model,snapshot,analysis,consumed_input,consumed_output) returning id into analysis_id;
  insert into public.source_chapter_alignments(source_id,source_url,reference_source_id,reference_urls,status,method,reason)
    values (target_source,chapter_url,reference_source,paired,'proposed','model',coalesce(analysis->>'reason',''))
    on conflict (owner_id,source_id,source_url,reference_source_id) do update set reference_urls = excluded.reference_urls, reason = excluded.reason, updated_at = now()
      where public.source_chapter_alignments.status = 'proposed';
  for term in select * from jsonb_array_elements(analysis->'terms') loop
    if not exists (select 1 from public.glossary_entries entry where entry.owner_id = auth.uid() and entry.novel_id = novel_key and entry.scope = 'novel' and entry.source_language = selected_source_language and entry.target_language = selected_target_language and entry.source_term = term->>'sourceTerm' and entry.sense = coalesce(term->>'sense','')) then
      insert into public.glossary_entries(novel_id,scope,source_language,target_language,source_term,target_term,category,sense,aliases,evidence,notes,status)
        values (novel_key,'novel',selected_source_language,selected_target_language,term->>'sourceTerm',term->>'targetTerm',term->>'category',coalesce(term->>'sense',''),array(select jsonb_array_elements_text(term->'aliases')),term->>'evidenceQuote','Source: ' || chapter_url || E'\nReference: ' || coalesce(term->>'referenceQuote','') || E'\nAnalysis: ' || analysis_id::text,'proposed');
    end if;
  end loop;
  return analysis_id;
end;
$$;
revoke all on function public.complete_source_analysis(text,uuid,text,uuid,integer,text,jsonb,jsonb,integer,integer) from public, anon;
grant execute on function public.complete_source_analysis(text,uuid,text,uuid,integer,text,jsonb,jsonb,integer,integer) to authenticated;