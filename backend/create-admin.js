import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SECRET_KEY;

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.log('Usage: node backend/create-admin.js <email> <password>');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function createAdmin() {
  console.log(`Creating admin account for ${email}...`);
  const { data: userRes, error: userErr } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  let userId = userRes?.user?.id;
  if (userErr) {
    if (userErr.message.includes('already registered')) {
      console.log('User already exists in auth. Finding user ID...');
      const { data: users } = await supabase.auth.admin.listUsers();
      const existing = users?.users?.find(u => u.email === email);
      if (existing) userId = existing.id;
    } else {
      console.error('Failed to create auth user:', userErr.message);
      process.exit(1);
    }
  }

  if (!userId) {
    console.error('Could not determine user ID.');
    process.exit(1);
  }

  const { error: adminErr } = await supabase.from('admin_users').upsert({ user_id: userId });
  if (adminErr) {
    console.error('Failed to grant admin privileges in admin_users:', adminErr.message);
    process.exit(1);
  }

  console.log('Admin account created successfully!');
  console.log(`Email: ${email}`);
  console.log(`User ID: ${userId}`);
  console.log('You can now log in at https://coach-nada.vercel.app/admin');
}

createAdmin();
