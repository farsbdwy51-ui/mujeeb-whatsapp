# مجيب — WhatsApp Worker ☁️

مساعد ردود العملاء بالذكاء الاصطناعي للمحلات المصرية — على واتساب مباشرة.
Cloudflare Worker بيستقبل رسايل WhatsApp Cloud API ويرد بنفس محرك مجيب القاعدي (rule-based) اللي بيشغّل ديمو الويب.

- الديمو: https://farsbdwy51-ui.github.io/mujeeb/
- التشغيل خطوة بخطوة: [SETUP.md](SETUP.md)

## البنية
- `src/engine.js` — محرك الردود (نسخة طبق الأصل من الديمو، الأوردر ١٠٠٪ قاعدي)
- `src/index.js` — Webhook (GET تحقق / POST رسايل)، جلسات + كتالوجات + أوردرات في KV
- `test/worker.test.js` — ١٨ اختبار شامل

## الاختبارات
```bash
node test/worker.test.js
```
