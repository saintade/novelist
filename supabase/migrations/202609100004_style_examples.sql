create table public.style_examples (
  id uuid not null default gen_random_uuid(),
  owner_id uuid not null default auth.uid(),
  novel_id uuid not null,
  book_id text not null,
  file_name text not null check (length(trim(file_name)) between 1 and 240),
  content_path text not null,
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  character_count integer not null check (character_count between 1 and 200000),
  created_at timestamptz not null default now(),
  primary key (owner_id, id),
  foreign key (owner_id, book_id, novel_id) references public.books (owner_id, id, novel_id) on delete cascade,
  unique (owner_id, novel_id, content_hash),
  check (content_path = owner_id::text || '/' || book_id || '/style-example-' || id::text || '.txt')
);

alter table public.style_examples enable row level security;
create policy "Own style examples" on public.style_examples for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, delete on public.style_examples to authenticated;

alter table public.style_profiles add column inference jsonb;

create function public.create_inferred_style(
  target_book text,
  expected_profile uuid,
  example_ids uuid[],
  style_instructions text,
  style_metadata jsonb
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  current_novel public.novels%rowtype;
  profile_id uuid := gen_random_uuid();
  example_count integer;
begin
  if coalesce(array_length(example_ids, 1), 0) not between 1 and 12
    or length(trim(style_instructions)) not between 1 and 6000
    or coalesce(jsonb_typeof(style_metadata), '') <> 'object' then
    raise exception 'Invalid inferred style';
  end if;

  select novels.* into current_novel from public.novels
  join public.books on books.owner_id = novels.owner_id and books.novel_id = novels.id
  where novels.owner_id = auth.uid() and books.id = target_book
  for update of novels;
  if not found then
    raise exception 'Book not found';
  end if;
  if current_novel.style_profile_id is distinct from expected_profile then
    raise exception 'The selected style changed. Reload before inferring again';
  end if;

  perform 1 from public.style_examples
  where owner_id = auth.uid() and novel_id = current_novel.id and id = any(example_ids)
  for share;
  get diagnostics example_count = row_count;
  if example_count <> array_length(example_ids, 1) then
    raise exception 'The selected examples changed. Reload before inferring again';
  end if;

  insert into public.style_profiles (id, owner_id, name, instructions, inference)
  values (
    profile_id,
    auth.uid(),
    left(current_novel.title, 85) || ' / ' || left(profile_id::text, 8),
    trim(style_instructions),
    style_metadata
  );
  update public.novels set style_profile_id = profile_id
  where owner_id = auth.uid() and id = current_novel.id;
  return profile_id;
end;
$$;
revoke all on function public.create_inferred_style(text, uuid, uuid[], text, jsonb) from public, anon;
grant execute on function public.create_inferred_style(text, uuid, uuid[], text, jsonb) to authenticated;