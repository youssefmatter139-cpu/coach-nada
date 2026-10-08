import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
let serverProcess;
let origin;
let serverOutput = '';

before(async () => {
  const portProbe = createServer();
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const { port } = portProbe.address();
  await new Promise((resolve, reject) => portProbe.close(error => error ? reject(error) : resolve()));

  origin = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['backend/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      TRUST_PROXY_HOPS: '0',
      SUPABASE_URL: '',
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverProcess.stdout.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });
  serverProcess.stderr.setEncoding('utf8').on('data', chunk => { serverOutput += chunk; });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (serverProcess.exitCode !== null) throw new Error(`Test server exited with code ${serverProcess.exitCode}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Test server did not start.');
});

after(() => {
  serverProcess?.kill();
});

test('serves local front-end assets with a restrictive content security policy', async () => {
  const response = await fetch(`${origin}/`);
  const html = await response.text();
  const csp = response.headers.get('content-security-policy');

  assert.equal(response.status, 200);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
  assert.doesNotMatch(html, /cdn\.tailwindcss\.com|unpkg\.com\/lucide/);

  for (const [asset, type] of [
    ['/tailwind.css', 'text/css'],
    ['/style.css', 'text/css'],
    ['/app.js', 'javascript'],
    ['/vendor/lucide.js', 'javascript']
  ]) {
    const assetResponse = await fetch(`${origin}${asset}`);
    assert.equal(assetResponse.status, 200, `${asset} should load`);
    assert.match(assetResponse.headers.get('content-type'), new RegExp(type));
  }
});

test('health and terminal logs clearly report missing Supabase configuration', async () => {
  const response = await fetch(`${origin}/health`);
  const health = await response.json();

  assert.equal(health.supabase, false);
  assert.equal(health.leadStorageConfigured, false);
  assert.match(serverOutput, /supabase_configuration_missing/);
});

test('limits lead submissions to three attempts per IP per window despite spoofed forwarding headers', async () => {
  const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => fetch(`${origin}/api/leads`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${index + 1}`
    },
    body: JSON.stringify({})
  })));

  assert.deepEqual(responses.map(response => response.status).sort(), [429, 503, 503, 503]);
  const limited = responses.find(response => response.status === 429);
  assert.match(limited.headers.get('ratelimit-limit'), /3/);
});

test('limits admin login attempts', async () => {
  const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.com', password: 'invalid' })
  })));

  assert.deepEqual(responses.map(response => response.status).sort(), [429, 503, 503, 503, 503, 503]);
});

test('database schema denies public access and preserves existing leads', async () => {
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

  assert.doesNotMatch(schema, /drop\s+table\s+if\s+exists\s+public\.leads/i);
  assert.match(schema, /alter table public\.leads enable row level security/i);
  assert.match(schema, /alter table public\.lead_dedupes enable row level security/i);
  assert.match(schema, /alter table public\.admin_users enable row level security/i);
  assert.match(schema, /revoke all on table public\.admin_users from public, anon, authenticated/i);
  assert.doesNotMatch(schema, /for all\s+to public\s+using\s*\(true\)/i);
});

test('lead API sends the mapped columns to Supabase with the service-role credential', async () => {
  const supabaseRequests = [];
  let insertedLead;
  let failInsert = false;
  const mockSupabase = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(request.url, 'http://127.0.0.1');
    supabaseRequests.push({
      method: request.method,
      path: url.pathname,
      apiKey: request.headers.apikey,
      authorization: request.headers.authorization,
      body
    });

    response.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/rpc/claim_lead_dedupe')) {
      response.end('true');
    } else if (url.pathname.endsWith('/leads') && request.method === 'GET') {
      response.end('[]');
    } else if (url.pathname.endsWith('/leads') && request.method === 'POST') {
      insertedLead = JSON.parse(body);
      if (failInsert) {
        response.writeHead(400);
        response.end(JSON.stringify({ code: '42703', message: 'column package_price does not exist' }));
        return;
      }
      response.writeHead(201);
      response.end(JSON.stringify({ id: '00000000-0000-4000-8000-000000000001' }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ message: 'Unexpected mock Supabase request.' }));
    }
  });

  mockSupabase.listen(0, '127.0.0.1');
  await once(mockSupabase, 'listening');
  const supabasePort = mockSupabase.address().port;
  const appPortProbe = createServer();
  appPortProbe.listen(0, '127.0.0.1');
  await once(appPortProbe, 'listening');
  const appPort = appPortProbe.address().port;
  await new Promise((resolve, reject) => appPortProbe.close(error => error ? reject(error) : resolve()));

  const appProcess = spawn(process.execPath, ['backend/server.js'], {
    cwd: new URL('../', import.meta.url),
    env: {
      ...process.env,
      PORT: String(appPort),
      NODE_ENV: 'test',
      TRUST_PROXY_HOPS: '0',
      SUPABASE_URL: `http://127.0.0.1:${supabasePort}`,
      SUPABASE_ANON_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let appOutput = '';
  appProcess.stdout.setEncoding('utf8').on('data', chunk => { appOutput += chunk; });
  appProcess.stderr.setEncoding('utf8').on('data', chunk => { appOutput += chunk; });

  try {
    const appOrigin = `http://127.0.0.1:${appPort}`;
    let healthy = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (appProcess.exitCode !== null) throw new Error(`Configured test server exited with code ${appProcess.exitCode}`);
      try {
        const response = await fetch(`${appOrigin}/health`);
        healthy = response.ok && (await response.json()).leadStorageConfigured;
        if (healthy) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(healthy, true, 'lead storage should be configured');

    const response = await fetch(`${appOrigin}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Test Client',
        whatsapp: '01012345678',
        goal: 'glutes',
        package: 'Curvy Shape',
        package_price: 1200,
        fitness_goal: 'glutes',
        source: 'landing-page',
        whatsapp_opened_at: '2026-10-07T18:00:00.000Z'
      })
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.equal(result.ok, true);
    assert.equal(result.leadId, '00000000-0000-4000-8000-000000000001');
    assert.deepEqual(Object.keys(insertedLead).sort(), [
      'created_at', 'fitness_goal', 'goal', 'id', 'name', 'package',
      'package_price', 'source', 'status', 'whatsapp', 'whatsapp_opened_at'
    ]);
    assert.equal(insertedLead.whatsapp, '+201012345678');
    assert.equal(insertedLead.fitness_goal, insertedLead.goal);
    assert.equal(insertedLead.package_price, 1200);
    assert.ok(supabaseRequests.every(request => request.apiKey === 'test-service-role-key'));
    assert.ok(supabaseRequests.some(request => request.path.endsWith('/leads') && request.method === 'POST'));

    const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
    for (const column of Object.keys(insertedLead)) {
      assert.match(schema, new RegExp(`^\\s*${column}\\s+`, 'm'), `Supabase schema should define ${column}`);
    }

    const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.match(appSource, /const data=\{name,whatsapp:normalized,goal,package:packageName,package_price:planPrices\[packageName\],fitness_goal:goal,source:'landing-page',whatsapp_opened_at:new Date\(\)\.toISOString\(\)\}/);

    failInsert = true;
    const failedResponse = await fetch(`${appOrigin}/api/leads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Another Test',
        whatsapp: '01012345679',
        goal: 'fatloss',
        package: 'Shape Start',
        package_price: 700,
        fitness_goal: 'fatloss',
        source: 'landing-page',
        whatsapp_opened_at: '2026-10-07T18:05:00.000Z'
      })
    });
    assert.equal(failedResponse.status, 503);
    for (let attempt = 0; attempt < 20 && !appOutput.includes('supabase_lead_insert_failed'); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(appOutput, /supabase_lead_insert_failed/);
    assert.match(appOutput, /42703/);
    assert.doesNotMatch(appOutput, /Another Test|01012345679/);
  } finally {
    appProcess.kill();
    mockSupabase.close();
  }
});

test('distributed environment templates contain placeholders instead of live keys', async () => {
  for (const path of ['../.env.example', '../backend/.env.example']) {
    const template = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(template, /^SUPABASE_URL=https:\/\/YOUR_PROJECT\.supabase\.co$/m);
    assert.match(template, /^SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY$/m);
    assert.match(template, /^SUPABASE_SERVICE_ROLE_KEY=YOUR_SUPABASE_SERVICE_ROLE_KEY$/m);
  }
});
