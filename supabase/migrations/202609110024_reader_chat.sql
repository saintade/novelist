create table public.reader_chat_turns (
  id uuid not null,
  owner_id uuid not null default auth.uid(),
  book_id text not null,
  source_key text not null,
  chapter_position integer not null check (chapter_position >= 0),
  scope text not null check (scope in ('chapter','recent')),
  question text not null check (length(question) between 1 and 4000),
  answer text not null default '',
  citations jsonb not null default '[]'::jsonb,
  status text not null default 'running' check (status in ('running','completed','failed')),
  error text not null default '',
  model text,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (owner_id,id),
  foreign key (owner_id,book_id) references public.books(owner_id,id) on delete cascade
);
create index reader_chat_book_chapter on public.reader_chat_turns(owner_id,book_id,source_key,created_at);
alter table public.reader_chat_turns enable row level security;
create policy "Own reading conversations" on public.reader_chat_turns for all to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
grant select,insert,update,delete on public.reader_chat_turns to authenticated;