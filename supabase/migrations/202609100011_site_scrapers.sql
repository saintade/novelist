create table public.site_scrapers (
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  origin text not null check (origin ~ '^https?://[^/]+$'),
  page_kind text not null check (page_kind in ('chapter', 'index')),
  code text not null check (length(code) between 1 and 24000),
  code_hash text not null check (code_hash ~ '^[a-f0-9]{64}$'),
  contract_version text not null,
  report_id uuid not null,
  validated_at timestamptz not null default now(),
  primary key (owner_id, origin, page_kind)
);
alter table public.site_scrapers enable row level security;
create policy "Own site scrapers" on public.site_scrapers for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select, insert, update, delete on public.site_scrapers to authenticated;