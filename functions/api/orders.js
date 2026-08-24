// functions/api/orders.js
// 服务器端今日运单/历史数据 API：浏览器仅作缓存，真实数据保存在 Upstash。
import { authRequired } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  const session = await authRequired(request, env);
  if (!session) return json({ error: '登录已失效或无权限' }, 401);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const route = normalizeRoute(session.route);
  if (!route && session.role !== 'admin') return json({ error: '用户未绑定线路' }, 403);

  try {
    if (request.method === 'POST') {
      const body = await request.json();
      const targetRoute = session.role === 'admin' ? normalizeRoute(body.route) : route;
      if (!targetRoute || !Array.isArray(body.orders)) return json({ error: 'Missing required fields' }, 400);
      const today = body.date || new Date().toISOString().slice(0, 10);
      const normalizedOrders = body.orders.map((item, index) => normalizeOrder(item, index)).filter(item => item.name);
      const todayData = { date: today, route: targetRoute, vehicle: body.vehicle || '', orders: normalizedOrders, totalWeight: normalizeWeight(body.totalWeight), count: normalizedOrders.length, updatedAt: new Date().toISOString() };
      await redisSet(env, `today_orders:${targetRoute}`, todayData);
      await saveHistory(env, targetRoute, today, todayData);
      return json({ success: true, data: todayData });
    }

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const targetRoute = session.role === 'admin' ? normalizeRoute(url.searchParams.get('route') || '') : route;
      if (!targetRoute) return json({ error: '缺少线路' }, 400);
      const date = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
      const today = await redisGet(env, `today_orders:${targetRoute}`);
      const history = await redisGet(env, `history:${targetRoute}:${date}`);
      return json({ success: true, today: today || null, history: Array.isArray(history) ? history : [] });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) { console.error('orders api error', error); return json({ success: false, error: error.message }, 500); }
}

async function saveHistory(env, route, date, todayData) {
  const key = `history:${route}:${date}`;
  const old = await redisGet(env, key);
  let history = Array.isArray(old) ? old : [];
  const record = { date, route, vehicle: todayData.vehicle, count: todayData.count, weight: todayData.totalWeight, orders: todayData.orders, updatedAt: todayData.updatedAt };
  const i = history.findIndex(x => x?.date === date);
  if (i >= 0) history[i] = record; else history.push(record);
  if (history.length > 30) history = history.slice(-30);
  await redisSet(env, key, history);
}

function normalizeOrder(item,index){if(typeof item==='string')return{id:Date.now()+index,code:String(index+1).padStart(2,'0'),name:item.trim(),nav:'',weight:0,note:'',status:'待配送'};const s=item||{};return{id:s.id||Date.now()+index,code:String(s.code||s.index||index+1).padStart(2,'0'),name:String(s.name||s.storeName||s.shopName||s['门店名称']||'').trim(),nav:String(s.nav||s.navigation||s.url||s['导航']||'').trim(),weight:Number(s.weight??s['重量']??0)||0,note:String(s.note||s['备注']||'').trim(),status:s.status||'待配送'};}
function normalizeWeight(v){return v===null||v===undefined?'0':String(v).trim();}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s;}
async function redisGet(env,key){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`}});if(!r.ok)return null;const d=await r.json();if(!d.result)return null;try{return JSON.parse(d.result)}catch{return null}}
async function redisSet(env,key,value){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(value))});if(!r.ok)throw Error(`Redis保存失败: ${r.status}`);}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
