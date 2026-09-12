create table public.ai_request_usage (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  book_id text,
  operation text not null check (length(operation) between 1 and 64),
  model text not null check (length(model) between 1 and 120),
  group_size integer not null default 1 check (group_size between 1 and 10),
  state text not null default 'pending' check (state in ('pending','completed','incomplete','failed','unknown')),
  response_id text,
  input_tokens bigint check (input_tokens>=0),
  cached_input_tokens bigint check (cached_input_tokens>=0),
  output_tokens bigint check (output_tokens>=0),
  estimated_usd numeric check (estimated_usd>=0),
  error_code text not null default '',
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (owner_id,book_id) references public.books(owner_id,id) on delete set null (book_id)
);
create index ai_request_usage_owner_month on public.ai_request_usage(owner_id,created_at desc);
create table public.ai_budget_settings (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  monthly_alert_usd numeric check (monthly_alert_usd>0 and monthly_alert_usd<=1000000),
  warning_percent integer not null default 80 check (warning_percent between 1 and 100)
);
alter table public.ai_request_usage enable row level security;
alter table public.ai_budget_settings enable row level security;
create policy "Own AI request usage" on public.ai_request_usage for all to authenticated using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy "Own AI alert budget" on public.ai_budget_settings for all to authenticated using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy "Private library owner only" on public.ai_request_usage as restrictive for all to authenticated using ((select public.private_library_allowed())) with check ((select public.private_library_allowed()));
create policy "Private library owner only" on public.ai_budget_settings as restrictive for all to authenticated using ((select public.private_library_allowed())) with check ((select public.private_library_allowed()));
grant select,insert,update,delete on public.ai_request_usage,public.ai_budget_settings to authenticated;

create function public.ai_usage_overview(month_start date) returns jsonb
language sql stable security invoker set search_path='' as $$
  with selected as (
    select * from public.ai_request_usage where owner_id=auth.uid()
      and created_at>=month_start::timestamp at time zone 'UTC' and created_at<(month_start+interval '1 month')::timestamp at time zone 'UTC'
  ), models as (
    select model,count(*) as requests,coalesce(sum(input_tokens),0) as input_tokens,coalesce(sum(output_tokens),0) as output_tokens,
      coalesce(sum(estimated_usd),0) as estimated_usd,count(*) filter(where estimated_usd is null) as unknown_costs
      from selected group by model
  )
  select jsonb_build_object(
    'month',to_char(month_start,'YYYY-MM'),
    'trackingSince',(select min(created_at) from public.ai_request_usage where owner_id=auth.uid()),
    'budgetUsd',(select monthly_alert_usd from public.ai_budget_settings where owner_id=auth.uid()),
    'warningPercent',coalesce((select warning_percent from public.ai_budget_settings where owner_id=auth.uid()),80),
    'totals',(select jsonb_build_object('requests',count(*),'estimatedUsd',coalesce(sum(estimated_usd),0),'unknownCosts',count(*) filter(where estimated_usd is null),'inputTokens',coalesce(sum(input_tokens),0),'outputTokens',coalesce(sum(output_tokens),0),'failed',count(*) filter(where state in ('failed','incomplete','unknown'))) from selected),
    'models',coalesce((select jsonb_agg(to_jsonb(models) order by estimated_usd desc,model) from models),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(to_jsonb(recent) order by created_at desc) from (select id,book_id,operation,model,group_size,state,input_tokens,output_tokens,estimated_usd,error_code,created_at from selected order by created_at desc limit 40) recent),'[]'::jsonb),
    'providerSignal',(select jsonb_build_object('state',state,'errorCode',error_code,'at',created_at) from public.ai_request_usage where owner_id=auth.uid() and state<>'pending' order by created_at desc limit 1),
    'jobs',coalesce((select jsonb_agg(to_jsonb(jobs) order by updated_at desc) from (select batch.id,batch.book_id,book.title,batch.request_kind,batch.state,batch.range_start,batch.range_end,batch.retry_at,batch.max_attempts,batch.last_error_code,batch.error,batch.updated_at from public.translation_batches batch join public.books book on book.owner_id=batch.owner_id and book.id=batch.book_id where batch.owner_id=auth.uid() and batch.state not in ('completed','cancelled') order by batch.updated_at desc limit 50) jobs),'[]'::jsonb)
  );
$$;
revoke all on function public.ai_usage_overview(date) from public,anon;
grant execute on function public.ai_usage_overview(date) to authenticated;