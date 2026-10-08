# Coach Nada — Public Site + Private Leads Dashboard

## 1. Supabase setup
1. Create a Supabase project.
2. Open **SQL Editor**.
3. Paste the complete contents of `supabase/schema.sql` and run it.
4. Go to **Authentication → Users** and create the coach/admin account with email + password.
5. Copy that user's UUID.
6. In SQL Editor run:

```sql
insert into public.admin_users(user_id) values ('PASTE-ADMIN-USER-UUID-HERE');
```

## 2. Environment
Copy `.env.example` to `.env` and fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY`.
The service-role key must stay on the server and must never be put in `public/` or `admin/`.

## 3. Install and run
```bash
npm install
npm start
```
Public site: `http://localhost:3000/`
Private dashboard: `http://localhost:3000/admin/`

Tailwind CSS is built locally when `npm start` or `npm run dev` runs. Front-end scripts and styles do not depend on third-party JavaScript CDNs.

## 4. Security and tests
- Apply `supabase/schema.sql` in the Supabase SQL Editor after taking a database backup. It no longer drops the leads table; direct public access to leads, dedupe records, and admin membership is revoked. Public form submissions and admin operations must go through the backend.
- The lead endpoint allows 3 attempts per client IP in a 15-minute window. Admin login allows 5 attempts per IP in the same window. Limits use in-memory storage, so run one server instance per deployment unless a shared rate-limit store is configured.
- Set `TRUST_PROXY_HOPS` to the exact number of trusted reverse-proxy hops in front of Express. Use `0` when clients connect directly; do not trust client-supplied forwarding headers.
- Run `npm test` for the security and HTTP smoke tests.
- The Supabase service-role key previously present in the environment templates must be considered exposed. Revoke/rotate it in Supabase now, update the private server environment with the replacement, and never put it in a template or browser code.

## 5. Lead flow
The public form accepts Egyptian numbers such as `01012345678`, `011...`, `012...`, `015...`, and international forms such as `+201012345678` or `201012345678`. They are normalized server-side and stored as `+201012345678`.

The browser sends `name`, `whatsapp`, `goal`, `package`, `package_price`, `fitness_goal`, `source`, and `whatsapp_opened_at`. The backend validates these fields, normalizes the phone number, then inserts `id`, `name`, `whatsapp`, `goal`, `fitness_goal`, `package`, `package_price`, `status`, `source`, `whatsapp_opened_at`, and `created_at` into `public.leads` using the server-only service-role key. The WhatsApp page is opened after the save response; on a save error, the form shows a warning and retains a local retry copy when browser storage is available.

The server checks lead storage at startup and reports a structured `[lead]` log for configuration, validation, duplicate, and Supabase insert errors. `GET /health` reports `leadStorageConfigured`; it must be `true` before lead submissions can be stored. Keep `.env` private and configure `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the server environment. Never send the service-role key from the browser.

## 6. Where leads appear in Supabase
Supabase Dashboard → **Table Editor → public.leads**.
The admin dashboard reads the same table through the protected backend.
