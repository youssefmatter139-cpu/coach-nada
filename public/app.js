const plans=['Shape Start','Curvy Shape','Private Elite'];
const planPrices={'Shape Start':700,'Curvy Shape':1200,'Private Elite':2000};
const goalLabels={glutes:'تكبير ورسم الجزء السفلي',fatloss:'خسارة دهون ونحت الخصر',weightgain:'زيادة وزن وصحة'};
let selectedPlan='Curvy Shape';
let quiz={step:0,goal:null,level:null,location:null};
let leadSubmitting=false;

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';

function renderIcons(){if(window.lucide)window.lucide.createIcons()}
function openModal(html){const modal=$('#modal'),content=$('#modalContent');if(!modal||!content)return;content.innerHTML=html;modal.classList.remove('hidden');modal.classList.add('flex');document.body.classList.add('overflow-hidden');renderIcons()}
function closeModal(){const modal=$('#modal');if(!modal)return;modal.classList.add('hidden');modal.classList.remove('flex');document.body.classList.remove('overflow-hidden');leadSubmitting=false}

function normalizeEgyptianPhone(value){
  let phone=String(value||'').trim().replace(/[\s().-]/g,'');
  if(phone.startsWith('00'))phone='+'+phone.slice(2);
  if(phone.startsWith('+20'))phone=phone.slice(1);
  if(phone.startsWith('20')&&phone.length===12)phone='0'+phone.slice(2);
  if(/^1[0125]\d{8}$/.test(phone))phone='0'+phone;
  if(!/^01[0125]\d{8}$/.test(phone))return null;
  return '+20'+phone.slice(1);
}

function openLead(plan){
  selectedPlan=plans.includes(plan)?plan:'Curvy Shape';
  openModal(`<div class="text-center mb-6"><div class="w-12 h-12 rounded-2xl bg-rose-600/15 text-rose-400 grid place-items-center mx-auto"><i data-lucide="sparkles"></i></div><h2 class="text-2xl font-black mt-4">Start your transformation</h2><p class="text-sm text-[var(--muted)] mt-2">Quick intake — then we'll move to WhatsApp.</p></div>
  <form id="leadForm" class="space-y-4" novalidate>
    <label class="block text-sm font-semibold">Full Name <span class="ar">(الاسم بالكامل)</span><input name="name" required minlength="2" maxlength="100" autocomplete="name" class="mt-2 w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none focus:border-rose-500" /></label>
    <label class="block text-sm font-semibold">WhatsApp Number <span class="ar">(رقم الواتساب)</span><input name="whatsapp" required inputmode="tel" autocomplete="tel" maxlength="20" placeholder="01012345678 أو +201012345678" class="mt-2 w-full rounded-xl bg-white/5 border border-white/10 px-4 py-3 outline-none focus:border-rose-500" /></label>
    <label class="block text-sm font-semibold">Primary Goal <span class="ar">(الهدف)</span><select name="goal" required class="mt-2 w-full rounded-xl bg-[#17171a] border border-white/10 px-4 py-3"><option value="glutes">تكبير ورسم الجزء السفلي</option><option value="fatloss">خسارة دهون ونحت الخصر</option><option value="weightgain">زيادة وزن وصحة</option></select></label>
    <label class="block text-sm font-semibold">Selected Package<select name="package" required class="mt-2 w-full rounded-xl bg-[#17171a] border border-white/10 px-4 py-3">${plans.map(p=>`<option value="${p}" ${p===selectedPlan?'selected':''}>${p} — ${planPrices[p].toLocaleString('en-US')} EGP / month</option>`).join('')}</select></label>
    <button id="leadSubmit" class="btn w-full bg-rose-600 rounded-xl py-3.5 font-black text-white" type="submit">Confirm & Chat on WhatsApp <i data-lucide="arrow-up-right" class="inline w-4 h-4"></i></button>
    <p id="leadError" class="text-xs text-rose-400 min-h-4" role="alert"></p>
    <p class="text-[10px] text-[var(--muted)] text-center">Your details are used only to process your coaching inquiry.</p>
  </form>`);
  const form=$('#leadForm');if(form)form.onsubmit=submitLead;
}

function isDuplicateLead(name,phone){
  try{
    const recent=JSON.parse(localStorage.getItem('coach_nada_recent_lead')||'null');
    if(!recent)return false;
    return Date.now()-recent.timestamp<30000&&recent.name===name&&recent.whatsapp===phone;
  }catch{return false}
}
function rememberLead(name,phone){try{localStorage.setItem('coach_nada_recent_lead',JSON.stringify({name,whatsapp:phone,timestamp:Date.now()}))}catch{}}
function saveLeadFallback(data){try{const existing=JSON.parse(localStorage.getItem('coach_nada_pending_leads')||'[]');const key=[data.name.toLowerCase(),data.whatsapp,data.goal,data.package].join('|');if(!existing.some(x=>x.key===key)){existing.unshift({key,...data,createdAt:new Date().toISOString(),source:'landing-page'});localStorage.setItem('coach_nada_pending_leads',JSON.stringify(existing.slice(0,500)))}return true}catch(err){console.error('Lead backup could not be stored in this browser.',err);return false} }
function removePendingLead(data){try{const existing=JSON.parse(localStorage.getItem('coach_nada_pending_leads')||'[]');const key=[data.name.toLowerCase(),data.whatsapp,data.goal,data.package].join('|');localStorage.setItem('coach_nada_pending_leads',JSON.stringify(existing.filter(x=>x.key!==key)))}catch{} }
async function syncPendingLeads(){try{const pending=JSON.parse(localStorage.getItem('coach_nada_pending_leads')||'[]');for(const item of pending.slice(0,10)){const {key,...data}=item;const response=await fetch(`${API_BASE}/api/leads`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),keepalive:true});if(response.ok)removePendingLead(data)}}catch{} }

async function submitLead(e){
  e.preventDefault(); if(leadSubmitting)return;
  const form=e.target,f=new FormData(form),error=$('#leadError'),button=$('#leadSubmit');
  const name=String(f.get('name')||'').trim(),normalized=normalizeEgyptianPhone(f.get('whatsapp'));
  if(name.length<2||name.length>100){error.textContent='من فضلك اكتبي الاسم بالكامل.';return}
  if(!normalized){error.textContent='من فضلك أدخلي رقم واتساب مصري صحيح مثل 01012345678 أو +201012345678.';return}
  const goal=String(f.get('goal')||''),packageName=String(f.get('package')||'');
  if(!plans.includes(packageName)){error.textContent='الباقة المختارة غير صالحة.';return}
  if(!goalLabels[goal]){error.textContent='الهدف المختار غير صالح.';return}
  if(isDuplicateLead(name,normalized)){error.textContent='تم إرسال نفس الطلب بالفعل. لو محتاجة تعيدي المحاولة انتظري 30 ثانية.';return}
  const data={name,whatsapp:normalized,goal,package:packageName,package_price:planPrices[packageName],fitness_goal:goal,source:'landing-page',whatsapp_opened_at:new Date().toISOString()};
  const backupSaved=saveLeadFallback(data);
  leadSubmitting=true;button.disabled=true;button.classList.add('opacity-60','cursor-not-allowed');button.textContent='جاري حفظ البيانات…';
  error.textContent='';
  const message=`مساء الخير كابتن ندى، أنا ${name} سجلت في الموقع ومحتاجة تفاصيل الاشتراك في باقة ${packageName}. هدفي هو ${goalLabels[goal]}.`;
  const waUrl=`https://wa.me/201227085543?text=${encodeURIComponent(message)}`;
  let waWindow=null;try{waWindow=window.open('about:blank','_blank');if(waWindow)waWindow.opener=null}catch{}
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
  try{
    const response=await fetch(`${API_BASE}/api/leads`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:controller.signal});
    const result=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(`${response.status}: ${result.error||'Server rejected the lead.'}${result.requestId?` (request ${result.requestId})`:''}`);
    removePendingLead(data);
    rememberLead(name,normalized);
    if(waWindow)waWindow.location.replace(waUrl);
    else window.location.href=waUrl;
    closeModal();
  }catch(err){
    console.error('Lead submission failed; the request was not confirmed as saved.',{message:err.message,backupSaved});
    error.textContent=backupSaved
      ?'تعذر تأكيد حفظ بياناتك في قاعدة البيانات. تم الاحتفاظ بمحاولة الإرسال على هذا الجهاز؛ افتحي واتساب الآن، ثم أعيدي المحاولة لاحقًا أو تواصلي مع الدعم.'
      :'تعذر حفظ البيانات على الخادم أو هذا الجهاز. افتحي واتساب، ثم تواصلي مع الدعم لإتمام التسجيل.';
    button.disabled=false;button.classList.remove('opacity-60','cursor-not-allowed');button.textContent='إعادة محاولة الحفظ';
    if(waWindow)waWindow.location.replace(waUrl);
    else window.location.href=waUrl;
  }finally{
    clearTimeout(timeout);
    leadSubmitting=false;
  }
}

function startQuiz(){quiz={step:0,goal:null,level:null,location:null};quizStep()}
function quizStep(){
  const titles=['What is your main goal?','What is your current fitness level?','Where do you prefer to train?'];
  const opts=[[['glutes','Glute Growth 🍑'],['fatloss','Fat Loss & Toning'],['recomp','Recomposition']],[['beginner','Beginner'],['intermediate','Intermediate'],['advanced','Advanced']],[['home','Home'],['gym','Gym']]][quiz.step];
  if(quiz.step<3){openModal(`<div><p class="text-xs text-rose-400 font-bold">STEP ${quiz.step+1} OF 3</p><h2 class="text-2xl font-black mt-2">${titles[quiz.step]}</h2><div class="grid gap-3 mt-6">${opts.map(([v,t])=>`<button type="button" class="glass text-left p-4 rounded-2xl hover:border-rose-500/50" data-quiz-pick="${v}"><span class="font-bold">${t}</span><i data-lucide="arrow-right" class="float-right"></i></button>`).join('')}</div></div>`)}
  else{const rec=quiz.goal==='glutes'?'Curvy Shape':quiz.goal==='fatloss'?'Shape Start':'Curvy Shape';openModal(`<div class="text-center"><div class="w-14 h-14 rounded-2xl bg-rose-600/15 text-rose-400 grid place-items-center mx-auto"><i data-lucide="sparkles"></i></div><p class="text-xs text-rose-400 font-bold mt-5">YOUR MATCH</p><h2 class="text-3xl font-black mt-2">${rec}</h2><p class="text-[var(--muted)] mt-3">Based on your goal, level and training location, this is the strongest starting match.</p><button type="button" data-action="open-lead" data-plan="${rec}" class="btn w-full bg-rose-600 rounded-xl py-3 mt-6 font-black">Start with ${rec}</button></div>`)}
  syncPendingLeads();
renderIcons();
}
function quizPick(v){if(quiz.step===0)quiz.goal=v;if(quiz.step===1)quiz.level=v;if(quiz.step===2)quiz.location=v;quiz.step++;quizStep()}

const obs=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting)e.target.classList.add('show')}),{threshold:.12});
$$('.reveal').forEach(x=>obs.observe(x));
if(localStorage.getItem('nada_theme')==='light')document.documentElement.classList.add('light');

document.addEventListener('click', event=>{
  const action=event.target.closest('[data-action]');
  if(action){
    const name=action.dataset.action;
    if(name==='open-lead') openLead(action.dataset.plan);
    else if(name==='start-quiz') startQuiz();
    else if(name==='scroll-programs') document.querySelector('#programs')?.scrollIntoView({behavior:'smooth'});
    else if(name==='close-modal') closeModal();
  }
  const quizButton=event.target.closest('[data-quiz-pick]');
  if(quizButton) quizPick(quizButton.dataset.quizPick);
  const faqButton=event.target.closest('.faq > button');
  if(faqButton) faqButton.parentElement.classList.toggle('open');
  if(event.target.closest('#themeBtn')){document.documentElement.classList.toggle('light');localStorage.setItem('nada_theme',document.documentElement.classList.contains('light')?'light':'dark')}
  if(event.target.closest('#menuBtn')) $('#mobileMenu')?.classList.toggle('hidden');
  if(event.target.closest('#mobileMenu a')) $('#mobileMenu')?.classList.add('hidden');
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', renderIcons);
} else {
  renderIcons();
}
window.addEventListener('load', renderIcons);
