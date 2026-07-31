-- 既存のSupabaseプロジェクトに、ユーザー別の課題表示設定を追加する。
create table if not exists public.assignment_preferences (
  user_id uuid not null references auth.users(id) on delete cascade,
  course_id text not null,
  assignment_id text not null,
  hidden boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, course_id, assignment_id)
);

drop trigger if exists assignment_preferences_set_updated_at on public.assignment_preferences;
create trigger assignment_preferences_set_updated_at
before update on public.assignment_preferences
for each row execute function public.set_updated_at();

alter table public.assignment_preferences enable row level security;

-- このテーブルはHttpOnly Cookieで認証するアプリサーバーだけが操作する。
revoke all on public.assignment_preferences from anon, authenticated;
grant all on public.assignment_preferences to service_role;
