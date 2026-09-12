create table public.site_navigation (
  owner_id uuid not null default auth.uid(),
  origin text not null check (origin ~ '^https?://[^/]+$'),
  recipes jsonb not null default '[]' check (jsonb_typeof(recipes) = 'array' and jsonb_array_length(recipes) <= 40),
  validated_at timestamptz not null default now(),
  primary key (owner_id, origin),
  foreign key (owner_id) references auth.users(id) on delete cascade
);
alter table public.site_navigation enable row level security;
create policy "Own site navigation" on public.site_navigation for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.site_navigation to authenticated;