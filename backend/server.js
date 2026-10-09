import dotenv from 'dotenv';
dotenv.config();

if (process.env.NODE_ENV !== 'test') {
  const currentUrl = process.env.SUPABASE_URL || '';
  if (!currentUrl || currentUrl.includes('<') || currentUrl.includes('>') || currentUrl.includes('YOUR_PROJECT')) {
    dotenv.config({ override: true });
  }
}
import express from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import morgan from 'morgan';
import { z } from 'zod';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const adminDir = path.join(rootDir, 'admin');
const app = express();
const PORT = Number(process.env.PORT || 3000);
function cleanEnvValue(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

const SUPABASE_URL = cleanEnvValue(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL);
const SERVICE_KEY = cleanEnvValue(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_SECRET
);
const ANON_KEY = cleanEnvValue(
  process.env.SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.SUPABASE_PUBLISHABLE_KEY
);
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY_HOPS ?? 0);
if (!Number.isInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 0) {
  throw new Error('TRUST_PROXY_HOPS must be a non-negative integer.');
}
const LEADS_TABLE = 'leads';

function initSupabaseClient(url, key) {
  if (!url || !key) return null;
  try {
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  } catch (error) {
    console.error(`[supabase] Failed to initialize Supabase client: ${error.message}`);
    return null;
  }
}

const supabase = initSupabaseClient(SUPABASE_URL, SERVICE_KEY);
const authClient = initSupabaseClient(SUPABASE_URL, ANON_KEY);

function logLeadEvent(level, event, metadata = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...metadata };
  console[level](`[lead] ${JSON.stringify(entry)}`);
}

function supabaseErrorMetadata(error) {
  return {
    code: error?.code || null,
    message: error?.message || 'Unknown Supabase error',
    details: error?.details || null,
    hint: error?.hint || null
  };
}

app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY_HOPS);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"]
    }
  }
}));
app.use(compression());
app.use(express.json({ limit:'20kb', strict:true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || origin === 'null' || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const isDev = process.env.NODE_ENV === 'development';
const apiLimiter = rateLimit({ windowMs:15*60*1000, max: isDev ? 1000 : 100, standardHeaders:true, legacyHeaders:false, message:{ok:false,error:'Too many API requests. Please try again later.'} });
const leadLimiter = rateLimit({ windowMs:15*60*1000, max: isDev ? 100 : 3, standardHeaders:true, legacyHeaders:false, message:{ok:false,error:'Too many lead submissions. Please try again in 15 minutes.'} });
const adminLimiter = rateLimit({ windowMs:15*60*1000, max: isDev ? 100 : 5, standardHeaders:true, legacyHeaders:false, message:{ok:false,error:'Too many login attempts. Please try again in 15 minutes.'} });
app.use('/api', apiLimiter);

async function verifyLeadStorage() {
  if (!supabase) {
    logLeadEvent('error', 'supabase_configuration_missing', {
      supabaseUrlConfigured: Boolean(SUPABASE_URL),
      serviceRoleKeyConfigured: Boolean(SERVICE_KEY)
    });
    return;
  }

  const { error } = await supabase.from(LEADS_TABLE).select('id').limit(1);
  if (error) {
    logLeadEvent('error', 'supabase_startup_check_failed', supabaseErrorMetadata(error));
    return;
  }
  logLeadEvent('info', 'supabase_startup_check_succeeded');
}

const packages = Object.freeze({ 'Shape Start':700, 'Curvy Shape':1200, 'Private Elite':2000 });
const goals = ['glutes','fatloss','weightgain'];
const leadSchema = z.object({
  name:z.string().trim().min(2).max(100), whatsapp:z.string().trim().min(1), goal:z.enum(goals),
  package:z.enum(Object.keys(packages)), package_price:z.coerce.number().int().optional(), fitness_goal:z.enum(goals).optional(),
  source:z.string().trim().max(80).optional().default('landing-page'), whatsapp_opened_at:z.string().datetime().optional()
}).strict();
const recentLeadClaims = new Map();

function normalizeEgyptianPhone(value){
  let phone=String(value??'').trim().replace(/[\s().-]/g,'');
  if(phone.startsWith('00')) phone='+'+phone.slice(2);
  if(phone.startsWith('+20')) phone=phone.slice(1);
  if(phone.startsWith('20') && phone.length===12) phone='0'+phone.slice(2);
  if(/^1[0125]\d{8}$/.test(phone)) phone='0'+phone;
  if(!/^01[0125]\d{8}$/.test(phone)) return null;
  return '+20'+phone.slice(1);
}
function dedupeKey(lead){ return createHash('sha256').update([lead.name.toLowerCase(),lead.whatsapp,lead.goal,lead.package].join('|')).digest('hex'); }
function isRecentMemoryDuplicate(key){ const exp=recentLeadClaims.get(key); if(!exp)return false; if(exp>Date.now())return true; recentLeadClaims.delete(key); return false; }
function rememberRecentLead(key){ recentLeadClaims.set(key,Date.now()+30000); }
setInterval(()=>{const now=Date.now();for(const [k,e] of recentLeadClaims)if(e<=now)recentLeadClaims.delete(k)},60000).unref();

async function requireAdmin(req,res,next){
  if(!supabase)return res.status(503).json({ok:false,error:'Admin service is unavailable.'});
  const auth=req.headers.authorization||'';
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  if(!token)return res.status(401).json({ok:false,error:'Authentication required.'});
  try{
    const {data:{user},error}=await supabase.auth.getUser(token);
    if(error||!user)return res.status(401).json({ok:false,error:'Invalid session.'});
    const {data:admin,error:adminError}=await supabase.from('admin_users').select('user_id').eq('user_id',user.id).maybeSingle();
    if(adminError||!admin)return res.status(403).json({ok:false,error:'Admin access denied.'});
    req.adminUser=user; next();
  }catch{ return res.status(401).json({ok:false,error:'Authentication failed.'}); }
}

app.post('/api/leads',leadLimiter,async(req,res)=>{
  const requestId=randomUUID();
  res.setHeader('X-Request-Id',requestId);
  if(!supabase){
    logLeadEvent('error','lead_rejected_supabase_not_configured',{requestId,supabaseUrlConfigured:Boolean(SUPABASE_URL),serviceRoleKeyConfigured:Boolean(SERVICE_KEY)});
    return res.status(503).json({ok:false,error:'Lead service is not configured.',requestId});
  }
  const body={...(req.body||{})};
  logLeadEvent('info','lead_request_received',{requestId,fieldNames:Object.keys(body)});
  const normalized=normalizeEgyptianPhone(body.whatsapp);
  if(normalized)body.whatsapp=normalized;
  body.fitness_goal=body.goal;
  const parsed=leadSchema.safeParse(body);
  if(!parsed.success){
    logLeadEvent('warn','lead_validation_failed',{requestId,issues:parsed.error.issues.map(issue=>({path:issue.path.join('.'),code:issue.code,message:issue.message}))});
    return res.status(400).json({ok:false,error:'Invalid lead data.',requestId});
  }
  const expectedPrice=packages[parsed.data.package];
  if(parsed.data.package_price!==undefined&&parsed.data.package_price!==expectedPrice){
    logLeadEvent('warn','lead_package_price_mismatch',{requestId,package:parsed.data.package,expectedPrice,receivedPrice:parsed.data.package_price});
    return res.status(400).json({ok:false,error:'Package price validation failed.',requestId});
  }
  if(parsed.data.fitness_goal!==parsed.data.goal){
    logLeadEvent('warn','lead_goal_mismatch',{requestId});
    return res.status(400).json({ok:false,error:'Goal validation failed.',requestId});
  }
  const lead={id:randomUUID(),name:parsed.data.name,whatsapp:parsed.data.whatsapp,goal:parsed.data.goal,fitness_goal:parsed.data.goal,package:parsed.data.package,package_price:expectedPrice,status:'new',source:parsed.data.source,whatsapp_opened_at:parsed.data.whatsapp_opened_at||null,created_at:new Date().toISOString()};
  const key=dedupeKey(lead);
  if(isRecentMemoryDuplicate(key)){
    logLeadEvent('info','lead_duplicate_blocked',{requestId});
    return res.status(200).json({ok:true,duplicate:true,error:'Duplicate lead blocked.',requestId});
  }
  try{
    const {data:recent,error:recentError}=await supabase.from(LEADS_TABLE).select('id,created_at').eq('whatsapp',lead.whatsapp).eq('name',lead.name).eq('goal',lead.goal).eq('package',lead.package).gte('created_at',new Date(Date.now()-30000).toISOString()).limit(1);
    if(recentError){
      logLeadEvent('error','supabase_duplicate_lookup_failed',{requestId,...supabaseErrorMetadata(recentError)});
      return res.status(503).json({
        ok:false,
        error: recentError.code === '42501'
          ? 'Supabase permission denied: SUPABASE_SERVICE_ROLE_KEY is missing or invalid in Vercel settings.'
          : (recentError.message || 'Unable to verify duplicate lead.'),
        code: recentError.code,
        requestId
      });
    }
    if(recent?.length){
      rememberRecentLead(key);
      logLeadEvent('info','lead_already_saved',{requestId,leadId:recent[0].id});
      return res.status(200).json({ok:true,leadId:recent[0].id,duplicate:true,requestId});
    }
    const {data:claim,error:claimError}=await supabase.rpc('claim_lead_dedupe',{p_dedupe_key:key,p_expires_at:new Date(Date.now()+30000).toISOString()});
    if(claimError){
      logLeadEvent('error','supabase_dedupe_claim_failed',{requestId,...supabaseErrorMetadata(claimError)});
      return res.status(503).json({
        ok:false,
        error: claimError.code === '42501'
          ? 'Supabase permission denied: SUPABASE_SERVICE_ROLE_KEY is missing or invalid in Vercel settings.'
          : (claimError.message || 'Unable to reserve lead submission.'),
        code: claimError.code,
        requestId
      });
    }
    if(claim!==true){
      logLeadEvent('info','lead_duplicate_claim_blocked',{requestId});
      return res.status(409).json({ok:false,duplicate:true,error:'A matching lead submission is already in progress.',requestId});
    }
    const {data:inserted,error:insertError}=await supabase.from(LEADS_TABLE).insert(lead).select('id').single();
    if(insertError){
      logLeadEvent('error','supabase_lead_insert_failed',{requestId,...supabaseErrorMetadata(insertError)});
      return res.status(503).json({
        ok:false,
        error: insertError.code === '42501'
          ? 'Supabase permission denied: SUPABASE_SERVICE_ROLE_KEY is missing or invalid in Vercel settings.'
          : (insertError.message || 'Unable to store lead right now.'),
        code: insertError.code,
        requestId
      });
    }
    rememberRecentLead(key);
    logLeadEvent('info','lead_saved',{requestId,leadId:inserted.id});
    return res.status(201).json({ok:true,leadId:inserted.id,requestId});
  }catch(error){
    logLeadEvent('error','lead_storage_unexpected_error',{requestId,...supabaseErrorMetadata(error)});
    return res.status(503).json({ok:false,error:error?.message||'Unable to store lead right now.',requestId});
  }
});

app.post('/api/admin/login',adminLimiter,async(req,res)=>{
  if(!authClient||!supabase)return res.status(503).json({ok:false,error:'Admin service is unavailable.'});
  const parsed=z.object({email:z.string().email(),password:z.string().min(1)}).safeParse(req.body||{});
  if(!parsed.success)return res.status(400).json({ok:false,error:'Invalid login data.'});
  const {data,error}=await authClient.auth.signInWithPassword(parsed.data);
  if(error||!data.session)return res.status(401).json({ok:false,error:'Invalid email or password.'});
  const {data:admin}=await supabase.from('admin_users').select('user_id').eq('user_id',data.user.id).maybeSingle();
  if(!admin){await authClient.auth.signOut();return res.status(403).json({ok:false,error:'This account is not authorized as an admin.'});}
  return res.json({ok:true,access_token:data.session.access_token,user:{id:data.user.id,email:data.user.email}});
});

app.get('/api/admin/leads',requireAdmin,async(req,res)=>{
  const limit=Math.min(Math.max(Number(req.query.limit)||50,1),200); const search=String(req.query.search||'').trim(); const status=String(req.query.status||'').trim(); const pkg=String(req.query.package||'').trim();
  let q=supabase.from(LEADS_TABLE).select('*').order('created_at',{ascending:false}).limit(limit);
  if(status&&['new','contacted','converted','rejected'].includes(status))q=q.eq('status',status);
  if(pkg&&Object.hasOwn(packages,pkg))q=q.eq('package',pkg);
  if(search)q=q.or(`name.ilike.%${search.replace(/[%_]/g,'')}%,whatsapp.ilike.%${search.replace(/[%_]/g,'')}%`);
  const {data,error}=await q; if(error)return res.status(500).json({ok:false,error:'Unable to load leads.'}); return res.json({ok:true,leads:data||[]});
});
app.patch('/api/admin/leads/:id',requireAdmin,async(req,res)=>{
  const parsed=z.object({status:z.enum(['new','contacted','converted','rejected'])}).safeParse(req.body||{}); if(!parsed.success)return res.status(400).json({ok:false,error:'Invalid status.'});
  const {data,error}=await supabase.from(LEADS_TABLE).update({status:parsed.data.status}).eq('id',req.params.id).select('*').single();
  if(error)return res.status(404).json({ok:false,error:'Lead not found.'}); return res.json({ok:true,lead:data});
});
app.get('/api/admin/stats',requireAdmin,async(_req,res)=>{
  const {data,error}=await supabase.from(LEADS_TABLE).select('status,created_at'); if(error)return res.status(500).json({ok:false,error:'Unable to load stats.'});
  const today=new Date().toISOString().slice(0,10); const stats={total:data.length,today:0,new:0,contacted:0,converted:0,rejected:0};
  for(const l of data){if(String(l.created_at).slice(0,10)===today)stats.today++;if(stats[l.status]!==undefined)stats[l.status]++;} return res.json({ok:true,stats});
});
app.get('/health',async(_req,res)=>{
  let dbOk=false; let dbError=null;
  if(supabase){
    const {error}=await supabase.from(LEADS_TABLE).select('id').limit(1);
    if(error){dbError={code:error.code,message:error.message};}else{dbOk=true;}
  }
  return res.json({
    ok:true,
    supabase:Boolean(supabase),
    auth:Boolean(authClient),
    leadStorageConfigured:Boolean(supabase),
    dbOk,
    dbError,
    keyPrefix:SERVICE_KEY?SERVICE_KEY.slice(0,10):null,
    keyLen:SERVICE_KEY?SERVICE_KEY.length:0
  });
});
app.use('/admin',express.static(adminDir,{extensions:['html']}));
app.get('/vendor/lucide.js',(_req,res)=>res.sendFile(path.join(rootDir,'node_modules','lucide','dist','umd','lucide.js')));
app.use(express.static(publicDir,{extensions:['html']}));
app.get('/admin/*',(_req,res)=>res.sendFile(path.join(adminDir,'index.html')));
app.get('*',(_req,res)=>res.sendFile(path.join(publicDir,'index.html')));
if (!process.env.VERCEL) {
  app.listen(PORT,()=>{
    console.log(`Coach Nada site running on http://localhost:${PORT}`);
    void verifyLeadStorage().catch(error=>logLeadEvent('error','supabase_startup_check_crashed',supabaseErrorMetadata(error)));
  });
}

export default app;
