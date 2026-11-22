import '../src/engine.cjs';
import { replySandbox, handleSandbox } from '../src/sandbox.js';
import assert from 'node:assert/strict';
const db = new Map(); let sends = []; let counter=0;
const env = {D360_API_KEY:'test',D360_WEBHOOK_TOKEN:'test-token',D360_RECIPIENT:'201035605359',MUJEEB_KV:{
 async get(k,o){const v=db.get(k);return v&&o?.type==='json'?JSON.parse(v):v;},async put(k,v){db.set(k,v);}
}};
globalThis.fetch=async (url,opts)=>{sends.push(JSON.parse(opts.body));return new Response('{}',{status:200});};
const base={from:'201035605359',from_user_id:'secondary-id',type:'text'};
async function send(text){await replySandbox({...base,id:'test-'+(++counter),text:{body:text}},env);return sends.at(-1).text.body;}
const state=()=>JSON.parse(db.get('d360:sess:201035605359')).session;
await send('اهلا');assert.equal(sends.at(-1).to,'201035605359');assert.equal(sends.at(-1).recipient,undefined);
const before=sends.length;await replySandbox({...base,id:'test-1',text:{body:'اهلا'}},env);assert.equal(sends.length,before);
await replySandbox({...base,id:'wrong',from:'wrong',text:{body:'اهلا'}},env);assert.equal(sends.length,before);
assert.equal((await handleSandbox(new Request('https://example.com/360dialog',{method:'POST',body:'{}'}),env,{})).status,403);
env.D360_RECIPIENT='bsuid-test';await replySandbox({...base,id:'bsuid',from:undefined,from_user_id:'bsuid-test',text:{body:'اهلا'}},env);assert.equal(sends.at(-1).recipient,'bsuid-test');env.D360_RECIPIENT='201035605359';
assert.match(await send('الأسعار'),/٣٥٠/);
assert.match(await send('طلب'),/اختار منتجك/);
assert.equal(state().stage,'order:product');
assert.match(await send('هلا'),/مجيب \| قطن ستور/);assert.equal(state().stage,null);
assert.match(await send('1'),/أسعار الديمو/);assert.equal(state().stage,null);
await send('الرئيسية');assert.match(await send('٢'),/اختار منتجك/);assert.equal(state().stage,'order:product');
await send('1');assert.equal(state().stage,'order:size');
await send('2');assert.equal(state().order.size,'M');
await send('1');assert.equal(state().order.color,'أبيض');assert.equal(state().stage,'order:qty');
await send('2');assert.equal(state().order.qty,2);
await send('عميل تجريبي');await send('01012345678');await send('1');await send('شارع تجريبي عمارة 10');await send('1');
assert.equal(state().stage,'order:confirm');assert.equal(state().order.total,745);
const confirmation=await send('1');assert.match(confirmation,/اتسجل طلبك التجريبي/);assert.doesNotMatch(confirmation,/الزرار الأخضر/);assert.equal(state().stage,null);assert.ok(state().placedOrders['1043']);
await send('اهلا');assert.ok(state().placedOrders['1043']);
assert.match(await send('أكلم موظف'),/مفيش موظف/);assert.equal(state().escalated,false);
assert.match(await send('الأسعار'),/أسعار الديمو/);
await send('نص غير معروف جدا');await send('نص غريب غير معروف');assert.equal(state().escalated,false);
assert.match(await send('مرحبا'),/مجيب \| قطن ستور/);assert.equal(state().fallbacks,0);
// Migrate the old production-style locked session without requiring a manual reset.
const stuck=state();stuck.escalated=true;stuck.fallbacks=3;db.set('d360:sess:201035605359',JSON.stringify({session:stuck,choices:[]}));
assert.match(await send('الأسعار'),/أسعار الديمو/);assert.equal(state().escalated,false);
console.log('PASS: transport authentication, dual-ID phone routing, BSUID, dedupe, distinct menu choices, Arabic numerals, sequential full order, totals, honest confirmation, preserved orders, handoff escape, fallback recovery, old locked-session migration. No network messages sent.');
