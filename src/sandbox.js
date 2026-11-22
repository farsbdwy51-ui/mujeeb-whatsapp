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
  const session = saved?.session || engine.newSession();
  let text = msg.text?.body || msg.interactive?.button_reply?.title || msg.button?.text;
  const digit = text?.trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  if (/^[1-9]$/.test(digit || '') && saved?.choices?.[Number(digit)-1]) text = saved.choices[Number(digit)-1];
  if (/^طلب$/.test(text?.trim() || '')) text = 'عايز اطلب';
  let response;
  let choices = [];
  let nextSession = session;
  if (!text) response = 'دي تجربة مجيب. ابعت سؤالك نص لو تسمح.';
  else {
    globalThis.CATALOG = DEFAULT_CATALOG;
    const out = engine.reply(text, session);
    response = (out.replies || []).map(r => r.text + (r.source ? '\n' + r.source : '')).join('\n\n');
    choices = out.quickReplies || [];
    if (out.orderConfirmed) {
      await kv.put('d360:demo-order:' + out.orderConfirmed.id, JSON.stringify(out.orderConfirmed), {expirationTtl:604800});
      response += '\n\nده طلب تجريبي محفوظ في الديمو فقط، لم يتم إرساله لمحل حقيقي.';
      nextSession = engine.newSession();
    }
    if (choices.length) response += '\n\n' + choices.map((c,i) => `${i+1}. ${c}`).join('\n');
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
