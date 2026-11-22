/* ============================================================
   مجيب — Cloudflare Worker: WhatsApp Cloud API webhook
   ------------------------------------------------------------
   - GET  /webhook  تحقق ميتا (hub.verify_token / hub.challenge)
   - POST /webhook  رسايل واتساب واردة → نفس engine.js القاعدي
   - كتالوج كل محل من KV (store:{phone_number_id}) وإلا الافتراضي
   - الجلسات في KV (TTL) عشان تتبع الطلبات يفضل شغال
   - مسار الطلب ١٠٠٪ قاعدي — مفيش AI في بيانات الأوردر
   ملاحظة تصميم: engine.reply متزامن، وبينادي CATALOG لحظيًا،
   فبنثبّت الكتالوج على globalThis قبل النداء ومفيش await بينهم.
   ============================================================ */

import "./engine.cjs";
import { DEFAULT_CATALOG } from "./stores/default.js";

const GRAPH_VERSION = "v22.0";

/* ---------- أدوات KV ---------- */
async function kvGet(env, key) {
  try {
    return await env.MUJEEB_KV.get(key, { type: "json" });
  } catch (e) {
    return null;
  }
}
async function kvPut(env, key, value, ttlSeconds) {
  try {
    await env.MUJEEB_KV.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch (e) {}
}

async function loadCatalog(env, phoneNumberId) {
  const fromKv = await kvGet(env, "store:" + phoneNumberId);
  return fromKv || DEFAULT_CATALOG;
}

async function loadSession(env, phoneNumberId, waId) {
  return (await kvGet(env, `sess:${phoneNumberId}:${waId}`)) || null;
}
async function saveSession(env, phoneNumberId, waId, session) {
  await kvPut(env, `sess:${phoneNumberId}:${waId}`, session, 7 * 24 * 3600);
}

/* ---------- إرسال رسايل واتساب ---------- */
async function sendWhatsApp(env, phoneNumberId, payload) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`graph send failed ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

function textPayload(to, body) {
  return { to, type: "text", text: { body: body.slice(0, 4000) } };
}

// أزرار واتساب التفاعلية: ٣ كحد أقصى، عنوان ٢٠ حرف
function buttonsPayload(to, body, replies) {
  return {
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body.slice(0, 1000) },
      action: {
        buttons: replies.slice(0, 3).map((r, i) => ({
          type: "reply",
          reply: { id: `qr_${i}_${r.slice(0, 12)}`, title: r.slice(0, 20) },
        })),
      },
    },
  };
}

/* ---------- معالجة رسالة واحدة ---------- */
async function handleMessage(env, phoneNumberId, msg, results) {
  const waId = msg.from;
  const ENGINE = globalThis.ENGINE;

  // منع التكرار (ميتا بتعيد إرسال الـ webhook أحيانًا)
  const seen = await kvGet(env, "seen:" + msg.id);
  if (seen) return;
  await kvPut(env, "seen:" + msg.id, true, 24 * 3600);

  // استخراج النص: رسالة نصية أو زرار تفاعلي
  let text = null;
  if (msg.type === "text") text = msg.text.body;
  else if (msg.type === "interactive" && msg.interactive.type === "button_reply") {
    text = msg.interactive.button_reply.title;
  }

  const session = (await loadSession(env, phoneNumberId, waId)) || ENGINE.newSession();

  if (!text) {
    const out = { replies: [{ text: "استقبلت رسالتك 👌 ابعتلي سؤالك نص لو تسمح." }] };
    await sendWhatsApp(env, phoneNumberId, textPayload(waId, out.replies[0].text));
    results.push({ waId, kind: "nontext" });
    return;
  }

  const catalog = await loadCatalog(env, phoneNumberId);
  globalThis.CATALOG = catalog; // متزامن مع ENGINE.reply — مفيش await بينهم
  const out = ENGINE.reply(text, session);

  // إرسال الردود: آخر رد + أزرار سريعة (لو ≤٣)، والباقي نص عادي
  const replies = out.replies || [];
  for (let i = 0; i < replies.length; i++) {
    const isLast = i === replies.length - 1;
    const chips = isLast && out.quickReplies && out.quickReplies.length > 0 && out.quickReplies.length <= 3
      ? out.quickReplies
      : null;
    if (chips) {
      await sendWhatsApp(env, phoneNumberId, buttonsPayload(waId, replies[i].text, chips));
    } else {
      await sendWhatsApp(env, phoneNumberId, textPayload(waId, replies[i].text));
    }
  }

  // الأوردر اتأكد: سجّله في KV (إشعار صاحب المحل بقالب رسمي — مرحلة الإنتاج)
  if (out.orderConfirmed) {
    await kvPut(
      env,
      `order:${phoneNumberId}:${out.orderConfirmed.id}`,
      { ...out.orderConfirmed, customerWaId: waId, at: new Date().toISOString() },
      60 * 24 * 3600
    );
    await sendWhatsApp(env, phoneNumberId, textPayload(waId, "📲 وصل طلبك للمحل ✅ هيتواصلوا معاك على رقمك للتأكيد."));
    // صفّر الجلسة بعد الطلب عشان الرسايل الجاية تبدأ من جديد
    await saveSession(env, phoneNumberId, waId, ENGINE.newSession());
    results.push({ waId, kind: "order", orderId: out.orderConfirmed.id });
    return;
  }

  await saveSession(env, phoneNumberId, waId, session);
  results.push({ waId, kind: "reply", count: replies.length });
}

/* ---------- الـ Worker ---------- */
async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);

  if (url.pathname !== "/webhook") {
    return new Response("مجيب واتساب Worker — شغال ✅", { status: 200 });
  }

  // تحقق ميتا من الـ webhook
  if (request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === env.VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return new Response("Bad request", { status: 400 });
  }

  const results = [];
  const jobs = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const phoneNumberId = value.metadata && value.metadata.phone_number_id;
      for (const msg of value.messages || []) {
        if (!phoneNumberId) continue;
        jobs.push(
          handleMessage(env, phoneNumberId, msg, results).catch((e) => {
            results.push({ error: String(e).slice(0, 200) });
          })
        );
      }
    }
  }
  // نرجع 200 فورًا لميتا ونكمل الإرسال في الخلفية
  ctx.waitUntil(Promise.all(jobs));
  return new Response("EVENT_RECEIVED", { status: 200 });
}

export default {
  fetch: handleRequest,
};

// للاختبارات: كل القطع الداخلية مكشوفة
export { handleMessage, loadCatalog, textPayload, buttonsPayload };
