import { DEFAULT_CATALOG } from './stores/default.js';

// Separate demo sessions and a secret callback URL keep the 25-message sandbox
// allowance isolated from the Meta integration. Never log credentials or bodies.
export async function handleSandbox(request, env, ctx) {
  const url = new URL(request.url);
  if (!env.D360_WEBHOOK_TOKEN || url.searchParams.get('token') !== env.D360_WEBHOOK_TOKEN) {
    return new Response('Forbidden', {status:403});
  }
  if (request.method !== 'POST') return new Response('Method not allowed', {status:405});
  if (!env.D360_API_KEY) return new Response('Not configured', {status:503});
  let body;
  try { body = await request.json(); } catch { return new Response('Bad request', {status:400}); }
  const values = Array.isArray(body.messages) || Array.isArray(body.statuses)
    ? [body]
    : (body.entry || []).flatMap(e => (e.changes || []).map(c => c.value || {}));
  const messages = values.flatMap(v => v.messages || []);
  const summary = {topKeys:Object.keys(body),valueKeys:values.map(v=>Object.keys(v)),messageCount:messages.length,messages:messages.map(m=>({keys:Object.keys(m),type:m.type,hasPhone:!!m.from,hasUserId:!!m.from_user_id,recipientMatches:m.from===env.D360_RECIPIENT||m.from_user_id===env.D360_RECIPIENT})),statusCount:values.reduce((n,v)=>n+(v.statuses?.length||0),0),statuses:values.flatMap(v=>(v.statuses||[]).map(s=>({status:s.status,errors:s.errors?.map(e=>({code:e.code,title:e.title}))})))};
  console.log('D360_CALLBACK',JSON.stringify(summary));
  await env.MUJEEB_KV.put('d360:last-callback',JSON.stringify({at:new Date().toISOString(),summary}),{expirationTtl:3600});
  ctx.waitUntil((async () => {
    for (const msg of messages) {
      try { await replySandbox(msg, env); }
      catch (e) { console.log('D360_ERROR', String(e).slice(0,180)); }
    }
  })());
  return new Response('EVENT_RECEIVED');
}

function freshSession(engine, old = {}) {
  return {...engine.newSession(),placedOrders:old.placedOrders || {},orderCounter:old.orderCounter || 1043};
}
function productList() {
  return DEFAULT_CATALOG.PRODUCTS.map((p,i) => `${i+1}. *${p.name}* • ${p.price.toLocaleString('ar-EG')} جنيه\n   المقاسات: ${p.sizes.join(' / ')}\n   الألوان: ${p.colors.join('، ')}`).join('\n\n');
}

export async function replySandbox(msg, env) {
  const recipient = msg.from === env.D360_RECIPIENT ? msg.from : msg.from_user_id;
  const useUserId = recipient !== msg.from;
  if (!recipient || !msg.id) return;
  // This key belongs to exactly one test recipient. Enforce it here as well.
  if (recipient !== env.D360_RECIPIENT) return;
  const kv = env.MUJEEB_KV;
  const seenKey = 'd360:seen:' + msg.id;
  if (await kv.get(seenKey)) return;
  await kv.put(seenKey, 'processing', {expirationTtl:86400});
  const sessKey = 'd360:sess:' + recipient;
  const saved = await kv.get(sessKey, {type:'json'});
  const engine = globalThis.ENGINE;
  let session = saved?.session || engine.newSession();
  // The sandbox has no staff queue. Never leave it in the production handoff lock.
  if (session.escalated) { session.escalated = false; session.fallbacks = 0; }
  let text = msg.text?.body || msg.interactive?.button_reply?.title || msg.button?.text;
  const digit = text?.trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (/^[1-9]$/.test(digit || '') && saved?.choices?.[Number(digit)-1]) text = saved.choices[Number(digit)-1];
  const normalized = engine.normalize(text || '').toLowerCase().replace(/^[^\p{L}\p{N}]+/u,'');
  const resetCommand = /^(اهلا(?: بيك)?|اهلا وسهلا|هلا|مرحبا|سلام|سلام عليكم|السلام عليكم|hello|hi|الرئيسيه|القائمه الرئيسيه|القائمه|menu|البدايه|ابدأ|ابدا)$/u.test(normalized);
  if (resetCommand) { session = freshSession(engine, session); text = 'اهلا'; }
  else if (/^(الاسعار|اسعار|prices?|price list)$/u.test(normalized)) {
    session.stage = null; session.order = {}; session.fallbacks = 0; text = 'الأسعار';
  }
  else if (/^(طلب|عايز اطلب|عاوز اطلب|اطلب|order)$/u.test(normalized)) {
    session.stage = null; session.order = {}; session.fallbacks = 0; text = 'عايز اطلب';
  }
  let response;
  let choices = [];
  let nextSession = session;
  if (!text) response = 'دي تجربة مجيب. ابعت سؤالك نص لو تسمح.';
  else {
    globalThis.CATALOG = DEFAULT_CATALOG;
    const out = engine.reply(text, session);
    response = (out.replies || []).map(r => r.text + (r.source ? '\n' + r.source : '')).join('\n\n');
    choices = out.quickReplies || [];
    let choicesRendered = false;
    if (resetCommand) {
      response = '*مجيب | قطن ستور* 👕\nأهلاً بيك! اختار اللي تحتاجه وأنا معاك خطوة بخطوة.\n\nدي نسخة عرض بمنتجات وطلبات تجريبية، من غير شراء أو دفع حقيقي.';
      choices = ['الأسعار','عايز اطلب','فين طلبي؟','الشحن والتوصيل','الاستبدال والاسترجاع'];
    } else if (session.stage === 'order:product') {
      response = '*🛍️ اختار منتجك | الخطوة ١ من ١٠*\n\n' + productList() + '\n\nالمصدر: كتالوج قطن ستور التجريبي\nابعت رقم المنتج أو اسمه.';
      choices = DEFAULT_CATALOG.PRODUCTS.map(p=>p.name);
      choicesRendered = true;
    } else if (/^(الاسعار|اسعار|prices?|price list)$/u.test(normalized)) {
      response = '*👕 مجموعة قطن ستور | أسعار الديمو*\n\n' + productList() + '\n\nالمصدر: كتالوج قطن ستور التجريبي\n\nتحب تبدأ طلب تجريبي؟';
      choices = ['عايز اطلب','القائمة الرئيسية'];
    }
    const step = {'order:size':'٢ من ١٠ • المقاس','order:color':'٣ من ١٠ • اللون','order:qty':'٤ من ١٠ • الكمية','order:name':'٥ من ١٠ • الاسم','order:phone':'٦ من ١٠ • الموبايل','order:governorate':'٧ من ١٠ • المحافظة','order:address':'٨ من ١٠ • العنوان','order:payment':'٩ من ١٠ • طريقة الدفع','order:confirm':'١٠ من ١٠ • مراجعة الطلب'}[session.stage];
    if (step) response = '*🛍️ طلب تجريبي | '+step+'*\n\n'+response;
    if (out.escalate || session.escalated) {
      response = 'دي نسخة تجريبية من مجيب، مفيش موظف خدمة عملاء متصل هنا، ولم تُرسل رسالتك لفريق حقيقي.\nتقدر تكمل التجربة: شوف الأسعار، ابدأ طلب تجريبي، أو ارجع للقائمة الرئيسية.';
      choices = ['الأسعار','عايز اطلب','القائمة الرئيسية'];
      session.escalated = false; session.fallbacks = 0; session.stage = null; session.order = {};
    }
    if (out.orderConfirmed) {
      await kv.put('d360:demo-order:' + out.orderConfirmed.id, JSON.stringify(out.orderConfirmed), {expirationTtl:604800});
      response = '*✅ اتسجل طلبك التجريبي #' + out.orderConfirmed.id + '*\n\n' + out.orderConfirmed.summary + '\n\nشكرًا لتجربتك مجيب 👕\nده عرض تجريبي فقط، لم يتم شراء أو دفع أو إرسال طلب لمحل حقيقي.';
      nextSession = freshSession(engine, session);
    }
    if (choices.length && !choicesRendered) response += '\n\n' + choices.map((c,i) => `${i+1}. ${c}`).join('\n');
    response += '\n\nاكتب *الرئيسية* للبدء من جديد.';
  }
  const payload = {messaging_product:'whatsapp',type:'text',text:{body:response.slice(0,4000)}};
  payload[useUserId ? 'recipient' : 'to'] = recipient;
  const res = await fetch('https://waba-sandbox.360dialog.io/v1/messages', {
    method:'POST',headers:{'Content-Type':'application/json','D360-API-KEY':env.D360_API_KEY},body:JSON.stringify(payload)
  });
  if (!res.ok) throw new Error('Sandbox send HTTP ' + res.status);
  await kv.put(sessKey, JSON.stringify({session:nextSession,choices}), {expirationTtl:604800});
  await kv.put(seenKey,'sent',{expirationTtl:86400});
  console.log('D360_SENT', JSON.stringify({id:msg.id,status:res.status}));
}
