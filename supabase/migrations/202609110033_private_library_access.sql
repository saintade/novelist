create schema if not exists novelist_private;
revoke all on schema novelist_private from public,anon,authenticated;
create table novelist_private.access_owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null references auth.users(id)
);

create function public.private_library_allowed() returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from novelist_private.access_owner)
    or exists (select 1 from novelist_private.access_owner where user_id = auth.uid()
      and coalesce((auth.jwt()->>'is_anonymous')::boolean,true) = false);
$$;
create function public.library_access_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('restricted',exists(select 1 from novelist_private.access_owner),
    'allowed',auth.uid() is not null and public.private_library_allowed());
$$;
revoke all on function public.private_library_allowed(),public.library_access_status() from public;
grant execute on function public.private_library_allowed(),public.library_access_status() to anon,authenticated;

create function public.configure_private_library(allowed_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare target record;
begin
  if not exists (select 1 from auth.users where id = allowed_user and is_anonymous = false and email_confirmed_at is not null) then
    raise exception 'Link and verify the existing library owner email before enabling private access';
  end if;
  insert into novelist_private.access_owner(singleton,user_id) values (true,allowed_user)
    on conflict (singleton) do update set user_id = excluded.user_id;
  for target in select namespace.nspname as schema_name, relation.relname as table_name
    from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
    where relation.relkind = 'r' and namespace.nspname = 'public' and relation.relrowsecurity
  loop
    if not exists (select 1 from pg_policies where schemaname = target.schema_name and tablename = target.table_name and policyname = 'Private library owner only') then
      execute format('create policy %I on %I.%I as restrictive for all to authenticated using (public.private_library_allowed()) with check (public.private_library_allowed())','Private library owner only',target.schema_name,target.table_name);
    end if;
  end loop;
end;
$$;
revoke all on function public.configure_private_library(uuid) from public,anon,authenticated;
grant execute on function public.configure_private_library(uuid) to postgres;

do $$
declare target record;
begin
  for target in select relation.relname from pg_class relation join pg_namespace namespace on namespace.oid = relation.relnamespace
    where relation.relkind = 'r' and namespace.nspname = 'public' and relation.relrowsecurity
  loop
    execute format('create policy %I on public.%I as restrictive for all to authenticated using (public.private_library_allowed()) with check (public.private_library_allowed())','Private library owner only',target.relname);
  end loop;
end;
$$;
create policy "Private library storage owner only" on storage.objects as restrictive for all to authenticated
  using (bucket_id <> 'library' or public.private_library_allowed())
  with check (bucket_id <> 'library' or public.private_library_allowed());