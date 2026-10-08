-- 1. تفعيل الامتدادات الضرورية
create extension if not exists pgcrypto;

-- 2. إنشاء جدول الليدز بدون حذف البيانات الموجودة عند إعادة تشغيل المخطط
create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  whatsapp text not null check (whatsapp ~ '^(\+20|0)?1[0125][0-9]{8}$'),
  goal text,
  fitness_goal text,
  package text not null default 'Curvy Shape',
  package_price integer default 1200,
  commission_rate numeric(4,2) not null default 0.20,
  commission_amount numeric(10,2) default 240,
  status text not null default 'new' check (status in ('new','contacted','converted','rejected')),
  source text not null default 'landing-page',
  whatsapp_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Safely add columns required by the lead API to older existing installations.
alter table public.leads add column if not exists goal text;
alter table public.leads add column if not exists fitness_goal text;
alter table public.leads add column if not exists package text not null default 'Curvy Shape';
alter table public.leads add column if not exists package_price integer not null default 1200;
alter table public.leads add column if not exists status text not null default 'new';
alter table public.leads add column if not exists source text not null default 'landing-page';
alter table public.leads add column if not exists whatsapp_opened_at timestamptz;
alter table public.leads add column if not exists created_at timestamptz not null default now();
alter table public.leads add column if not exists updated_at timestamptz not null default now();

-- 3. جدول منع تكرار الطلبات السريعة (Spam Prevention)
create table if not exists public.lead_dedupes (
  dedupe_key text primary key,
  expires_at timestamptz not null
);

-- 4. جدول المسؤولين والمطور (Admin Users)
create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- 5. فهرسة البيانات لتسريع عمليات البحث والتصفية
create index if not exists leads_whatsapp_idx on public.leads (whatsapp);
create index if not exists leads_status_created_idx on public.leads (status, created_at desc);

-- 6. دالة ومحفز لضبط السعر والنسبة ومزامنة الهدف تلقائياً قبل الحفظ
create or replace function public.handle_lead_pre_insert()
returns trigger language plpgsql as $$
begin
  -- تحديد السعر تلقائياً إذا لم يتم إرساله من الفورم
  if new.package_price is null or new.package_price = 0 then
    if new.package = 'Shape Start' then 
      new.package_price := 700;
    elsif new.package = 'Private Elite' then 
      new.package_price := 2000;
    else 
      new.package_price := 1200;
    end if;
  end if;

  -- حساب عمولة المطور تلقائياً (20%)
  new.commission_amount := round(new.package_price * coalesce(new.commission_rate, 0.20), 2);

  -- مزامنة حقلي goal و fitness_goal في حال وصول أحدهما فقط
  if new.goal is null and new.fitness_goal is not null then
    new.goal := new.fitness_goal;
  elsif new.fitness_goal is null and new.goal is not null then
    new.fitness_goal := new.goal;
  end if;

  return new;
end;
$$;

drop trigger if exists leads_pre_insert on public.leads;
create trigger leads_pre_insert 
before insert on public.leads 
for each row execute function public.handle_lead_pre_insert();

-- 7. محفز تحديث التاريخ تلقائياً عند تعديل أي صف
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin 
  new.updated_at := now(); 
  return new; 
end; 
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at 
before update on public.leads 
for each row execute function public.set_updated_at();

-- 8. دالة إلغاء تكرار الليد
create or replace function public.claim_lead_dedupe(p_dedupe_key text, p_expires_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare 
  claimed boolean;
begin
  insert into public.lead_dedupes (dedupe_key, expires_at)
  values (p_dedupe_key, p_expires_at)
  on conflict (dedupe_key) do update
    set expires_at = excluded.expires_at
    where public.lead_dedupes.expires_at <= pg_catalog.now();
    
  select exists(
    select 1 from public.lead_dedupes 
    where dedupe_key = p_dedupe_key and expires_at = p_expires_at
  ) into claimed;
  
  delete from public.lead_dedupes where expires_at <= pg_catalog.now();
  return claimed;
end;
$$;

-- 9. منع الوصول المباشر من المفاتيح العامة وقصر الوصول على الخادم الموثوق
revoke all on table public.leads from public, anon, authenticated, service_role;
revoke all on table public.lead_dedupes from public, anon, authenticated, service_role;
revoke all on table public.admin_users from public, anon, authenticated, service_role;

grant select, insert, update on table public.leads to service_role;
grant select on table public.admin_users to service_role;

revoke all on function public.claim_lead_dedupe(text, timestamptz) from public, anon, authenticated;
grant execute on function public.claim_lead_dedupe(text, timestamptz) to service_role;
revoke all on function public.handle_lead_pre_insert() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

-- 10. تفعيل RLS؛ لا توجد سياسات للزوار أو المستخدمين المسجلين
alter table public.leads enable row level security;
alter table public.lead_dedupes enable row level security;
alter table public.admin_users enable row level security;

drop policy if exists "Enable public insert" on public.leads;
drop policy if exists "Enable read and write for authenticated and service_role" on public.leads;

-- 11. تفعيل البث الحي (Realtime) لربطه بلوحة التحكم لاحقاً
do $$
begin
  if not exists (
    select 1 from pg_publication_tables 
    where pubname = 'supabase_realtime' and tablename = 'leads'
  ) then
    alter publication supabase_realtime add table public.leads;
  end if;
end;
$$;