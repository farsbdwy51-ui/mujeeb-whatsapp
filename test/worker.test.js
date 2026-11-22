/* اختبارات الـ Worker ببيئة وهمية: node test/worker.test.js */
import worker, { handleMessage } from "../src/index.js";

let fails = 0;
function check(cond, label, extra) {
  if (!cond) {
    fails++;
    console.log("❌ FAIL:", label, extra ? JSON.stringify(extra).slice(0, 300) : "");
  } else {
    console.log("✅", label);
  }
}

/* ---------- KV وهمي في الذاكرة ---------- */
function fakeKV() {
  const map = new Map();
  return {
    async get(key, opts) {
      const v = map.get(key);
      if (v === undefined) return null;
      return opts && opts.type === "json" ? JSON.parse(v) : v;
    },
    async put(key, value) {
      map.set(key, value);
    },
    _map: map,
  };
}

/* ---------- fetch وهمي يلتقط الإرسال ---------- */
let sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, status: 200, text: async () => "" };
};

const env = {
  MUJEEB_KV: fakeKV(),
  WHATSAPP_TOKEN: "TEST_TOKEN",
  VERIFY_TOKEN: "mujeeb-verify-123",
};

const ctx = {
  _p: Promise.resolve(),
  waitUntil(p) { this._p = p; },
};

function webhookBody(phoneNumberId, messages) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: phoneNumberId },
              messages,
            },
          },
        ],
      },
    ],
  };
}

async function post(body) {
  sent = [];
  const req = new Request("https://worker.example/webhook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, env, ctx);
  await ctx._p; // نستنى وظايف الخلفية (الإرسال) تخلص
  return res;
}

const PHONE_ID = "10987654321";
const CUSTOMER = "201011122233";

/* ============ ١) تحقق الـ webhook ============ */
console.log("===== webhook verify =====");
{
  const ok = await worker.fetch(
    new Request(`https://worker.example/webhook?hub.mode=subscribe&hub.verify_token=mujeeb-verify-123&hub.challenge=CH42`),
    env, ctx
  );
  check(ok.status === 200 && (await ok.text()) === "CH42", "verify: correct token echoes challenge");
  const bad = await worker.fetch(
    new Request(`https://worker.example/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=CH42`),
    env, ctx
  );
  check(bad.status === 403, "verify: wrong token -> 403");
}

/* ============ ٢) رسالة نصية بسيطة ============ */
console.log("===== رسالة ترحيب =====");
{
  const res = await post(webhookBody(PHONE_ID, [{ id: "wamid.1", from: CUSTOMER, type: "text", text: { body: "السلام عليكم" } }]));
  check(res.status === 200, "POST -> 200");
  const texts = sent.map((s) => s.body.text && s.body.text.body).filter(Boolean);
  check(texts.some((t) => /أهلاً بيك في قطن ستور/.test(t)), "greeting reply sent", texts);
  check(sent.every((s) => s.url.includes(PHONE_ID)), "sent via correct phone_number_id");
  check(sent.every((s) => s.body.to === CUSTOMER), "sent to the customer");
}

/* ============ ٣) أزرار تفاعلية لما الاقتراحات ≤ ٣ ============ */
console.log("===== أزرار تفاعلية =====");
{
  sent = [];
  await post(webhookBody(PHONE_ID, [{ id: "wamid.2", from: "201099988877", type: "text", text: { body: "الشحن للاسكندرية بكام؟" } }]));
  const interactive = sent.filter((s) => s.body.type === "interactive");
  check(interactive.length > 0, "interactive buttons used for quick replies", sent.map((s) => s.body.type));
  check(interactive[0].body.interactive.action.buttons.length <= 3, "max 3 buttons");
}

/* ============ ٤) مسار طلب كامل عبر الـ webhook ============ */
console.log("===== أوردر كامل =====");
{
  env.MUJEEB_KV = fakeKV(); // جلسة نضيفة
  const steps = [
    "عندكم تيشيرتات قطن؟",
    "عايز أطلب واحد",
    "L",
    "أسود",
    "2",
    "محمد أحمد",
    "01011223344",
    "القاهرة",
    "15 شارع التحرير الدقي الدور التالت",
    "كاش عند الاستلام",
    "تأكيد",
  ];
  let i = 10;
  for (const st of steps) {
    await post(webhookBody(PHONE_ID, [{ id: "wamid." + i++, from: CUSTOMER, type: "text", text: { body: st } }]));
  }
  const orderKeys = [...env.MUJEEB_KV._map.keys()].filter((k) => k.startsWith("order:"));
  check(orderKeys.length === 1, "order stored in KV", orderKeys);
  const order = JSON.parse(env.MUJEEB_KV._map.get(orderKeys[0]));
  check(/محمد أحمد/.test(order.summary) && /تيشيرت قطن بيزك/.test(order.summary), "order summary has customer + product");
  check(order.customerWaId === CUSTOMER, "order tagged with customer wa_id");
  const confirmations = sent.filter((s) => s.body.text && /وصل طلبك للمحل/.test(s.body.text.body || ""));
  check(confirmations.length > 0, "customer got order-forwarded confirmation");
  const sessionKeys = [...env.MUJEEB_KV._map.keys()].filter((k) => k.startsWith("sess:"));
  check(sessionKeys.length === 1, "session persisted");
}

/* ============ ٥) منع التكرار ============ */
console.log("===== dedup =====");
{
  const body = webhookBody(PHONE_ID, [{ id: "wamid.dup1", from: CUSTOMER, type: "text", text: { body: "الشحن بكام؟" } }]);
  await post(body);
  const firstCount = sent.length;
  await post(body); // نفس id
  check(sent.length === 0, "duplicate webhook ignored", { first: firstCount, after: sent.length });
}

/* ============ ٦) كتالوج مخصص من KV ============ */
console.log("===== store override من KV =====");
{
  const custom = JSON.parse(JSON.stringify((await import("../src/stores/default.js")).DEFAULT_CATALOG));
  custom.STORE.name = "محل الاختبار";
  const PHONE2 = "555000111";
  env.MUJEEB_KV._map.set("store:" + PHONE2, JSON.stringify(custom));
  sent = [];
  await post(webhookBody(PHONE2, [{ id: "wamid.c1", from: CUSTOMER, type: "text", text: { body: "السلام عليكم" } }]));
  check(sent.some((s) => s.body.text && /أهلاً بيك في محل الاختبار/.test(s.body.text.body)), "KV catalog overrides default", sent.map((s) => s.body.text && s.body.text.body));
}

/* ============ ٧) رسالة غير نصية ============ */
console.log("===== رسالة غير نصية =====");
{
  sent = [];
  await post(webhookBody(PHONE_ID, [{ id: "wamid.n1", from: CUSTOMER, type: "image", image: { id: "x" } }]));
  check(sent.some((s) => s.body.text && /ابعتلي سؤالك نص/.test(s.body.text.body)), "non-text gets polite nudge");
}

/* ============ ٨) زرار تفاعلي وارد بيتحول لنص ============ */
console.log("===== button_reply =====");
{
  sent = [];
  await post(webhookBody(PHONE_ID, [{
    id: "wamid.b1",
    from: CUSTOMER,
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "qr_0", title: "الشحن والتوصيل" } },
  }]));
  check(sent.some((s) => /شحن/.test(JSON.stringify(s.body))), "button tap routes by title text", sent.map((s) => s.body.type).join(","));
}

console.log(fails ? `\n${fails} فشل` : "\nكل الاختبارات نجحت ✅");
process.exit(fails ? 1 : 0);
