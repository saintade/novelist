create table public.library_folders (
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null check (name = trim(name) and length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (owner_id,id)
);
create unique index library_folder_names on public.library_folders(owner_id,lower(name));
alter table public.library_folders enable row level security;
create policy "Own library folders" on public.library_folders for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select,insert,update,delete on public.library_folders to authenticated;
alter table public.books add column folder_id uuid;
alter table public.books add constraint books_folder_fk foreign key (owner_id,folder_id)
  references public.library_folders(owner_id,id) on delete set null (folder_id);
create index books_by_folder on public.books(owner_id,folder_id);