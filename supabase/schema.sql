-- Supabase SQL Editor で一度だけ実行する。
create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  affiliation text not null default '',
  student_number text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.canvas_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  base_url text not null,
  token_ciphertext text not null,
  token_hint text not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint canvas_base_url_https check (base_url ~ '^https://[^/]+')
);

create table if not exists public.canvas_cache (
  user_id uuid primary key references auth.users(id) on delete cascade,
  payload jsonb not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.timetable_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day_of_week smallint not null check (day_of_week between 1 and 6),
  period smallint not null check (period between 1 and 7),
  course_name text not null check (char_length(course_name) between 1 and 200),
  room text not null default '',
  instructor text not null default '',
  canvas_course_id text,
  memo text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.report_templates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default '標準',
  full_name text not null default '',
  student_number text not null default '',
  faculty text not null default '',
  department text not null default '',
  cover_fields jsonb not null default '{}'::jsonb,
  submission_format jsonb not null default '{}'::jsonb,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.campus_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  url text not null check (url ~ '^https://'),
  category text not null default 'personal',
  is_global boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint global_link_owner check (
    (is_global and user_id is null) or
    (not is_global and user_id is not null)
  )
);

create table if not exists public.textbook_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  post_type text not null check (post_type in ('sell', 'buy')),
  title text not null check (char_length(title) between 1 and 200),
  course_name text not null default '',
  instructor text not null default '',
  price text not null default '',
  book_condition text not null default '',
  campus text not null default '',
  contact text not null default '',
  note text not null default '',
  visibility text not null default 'published'
    check (visibility in ('draft', 'published', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists timetable_user_sort
  on public.timetable_entries(user_id, day_of_week, period);
create index if not exists campus_links_owner
  on public.campus_links(user_id, is_global, sort_order);
create index if not exists textbook_posts_feed
  on public.textbook_posts(visibility, created_at desc);
create index if not exists textbook_posts_owner
  on public.textbook_posts(user_id, created_at desc);

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
for each row execute function public.set_updated_at();
drop trigger if exists canvas_credentials_set_updated_at on public.canvas_credentials;
create trigger canvas_credentials_set_updated_at before update on public.canvas_credentials
for each row execute function public.set_updated_at();
drop trigger if exists canvas_cache_set_updated_at on public.canvas_cache;
create trigger canvas_cache_set_updated_at before update on public.canvas_cache
for each row execute function public.set_updated_at();
drop trigger if exists timetable_set_updated_at on public.timetable_entries;
create trigger timetable_set_updated_at before update on public.timetable_entries
for each row execute function public.set_updated_at();
drop trigger if exists report_templates_set_updated_at on public.report_templates;
create trigger report_templates_set_updated_at before update on public.report_templates
for each row execute function public.set_updated_at();
drop trigger if exists campus_links_set_updated_at on public.campus_links;
create trigger campus_links_set_updated_at before update on public.campus_links
for each row execute function public.set_updated_at();
drop trigger if exists textbook_posts_set_updated_at on public.textbook_posts;
create trigger textbook_posts_set_updated_at before update on public.textbook_posts
for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.canvas_credentials enable row level security;
alter table public.canvas_cache enable row level security;
alter table public.timetable_entries enable row level security;
alter table public.report_templates enable row level security;
alter table public.campus_links enable row level security;
alter table public.textbook_posts enable row level security;

-- 秘密情報とCanvasキャッシュはservice_role経由のサーバーだけが操作する。
-- canvas_credentials と canvas_cache には authenticated 向けポリシーを作らない。

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
for select to authenticated using ((select auth.uid()) = id);
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
for update to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);

drop policy if exists timetable_all_own on public.timetable_entries;
create policy timetable_all_own on public.timetable_entries
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists report_templates_all_own on public.report_templates;
create policy report_templates_all_own on public.report_templates
for all to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists campus_links_select_visible on public.campus_links;
create policy campus_links_select_visible on public.campus_links
for select to authenticated
using (is_global or (select auth.uid()) = user_id);
drop policy if exists campus_links_insert_own on public.campus_links;
create policy campus_links_insert_own on public.campus_links
for insert to authenticated
with check (not is_global and (select auth.uid()) = user_id);
drop policy if exists campus_links_update_own on public.campus_links;
create policy campus_links_update_own on public.campus_links
for update to authenticated
using (not is_global and (select auth.uid()) = user_id)
with check (not is_global and (select auth.uid()) = user_id);
drop policy if exists campus_links_delete_own on public.campus_links;
create policy campus_links_delete_own on public.campus_links
for delete to authenticated
using (not is_global and (select auth.uid()) = user_id);

drop policy if exists textbook_posts_select_visible on public.textbook_posts;
create policy textbook_posts_select_visible on public.textbook_posts
for select to authenticated
using (visibility = 'published' or (select auth.uid()) = user_id);
drop policy if exists textbook_posts_insert_own on public.textbook_posts;
create policy textbook_posts_insert_own on public.textbook_posts
for insert to authenticated
with check ((select auth.uid()) = user_id);
drop policy if exists textbook_posts_update_own on public.textbook_posts;
create policy textbook_posts_update_own on public.textbook_posts
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
drop policy if exists textbook_posts_delete_own on public.textbook_posts;
create policy textbook_posts_delete_own on public.textbook_posts
for delete to authenticated
using ((select auth.uid()) = user_id);

revoke all on public.canvas_credentials from anon, authenticated;
revoke all on public.canvas_cache from anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.timetable_entries to authenticated;
grant select, insert, update, delete on public.report_templates to authenticated;
grant select, insert, update, delete on public.campus_links to authenticated;
grant select, insert, update, delete on public.textbook_posts to authenticated;


grant usage on schema public to service_role;
grant all on public.profiles to service_role;
grant all on public.canvas_credentials to service_role;
grant all on public.canvas_cache to service_role;
grant all on public.timetable_entries to service_role;
grant all on public.report_templates to service_role;
grant all on public.campus_links to service_role;
grant all on public.textbook_posts to service_role;

