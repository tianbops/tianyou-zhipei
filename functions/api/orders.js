// functions/api/orders.js
// 服务器端订单 API：浏览器仅缓存，真实数据保存在 Upstash。
// 数据链路：线路 -> orderBatchId -> 今日订单 -> 历史记录。
import { authRequired } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  const session = await authRequired(request, env);
  if (!session) return json({ error: '登录已失效或无权限' }, 401);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  const sessionRoute = normalizeRoute(session.route);
  if (!sessionRoute && session.role !== 'admin') return json({ error: '用户未绑定线路' }, 403);

  try {
    if (request.method === 'POST') {
      const body = await request.json();
      const targetRoute = session.role === 'admin' ? normalizeRoute(body.route) : sessionRoute;
      if (!targetRoute || !Array.isArray(body.orders)) return json({ error: '缺少线路或订单数据' }, 400);

      const date = normalizeDate(body.date) || new Date().toISOString().slice(0, 10);
      const existing = await redisGet(env, `today_orders:${targetRoute}`);
      const suppliedBatchId = String(body.orderBatchId || '').trim();
      const orderBatchId = suppliedBatchId || existing?.orderBatchId || createBatchId(targetRoute, date);
      const updatedAt = new Date().toISOString();
      const normalizedOrders = body.orders.map((item, index) => normalizeOrder(item, index, orderBatchId)).filter(item => item.name);
      const todayData = {
        orderBatchId,
        date,
        route: targetRoute,
        vehicle: String(body.vehicle || '').trim(),
        orders: normalizedOrders,
        totalWeight: normalizeWeight(body.totalWeight),
        count: normalizedOrders.length,
        source: body.source || 'web',
        updatedAt
      };

      await redisSet(env, `today_orders:${targetRoute}`, todayData);
      await saveHistory(env, targetRoute, date, todayData);
      return json({ success: true, data: todayData });
    }

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const targetRoute = session.role === 'admin' ? normalizeRoute(url.searchParams.get('route') || '') : sessionRoute;
      if (!targetRoute) return json({ error: '缺少线路' }, 400);
      const date = normalizeDate(url.searchParams.get('date')) || new Date().toISOString().slice(0, 10);
      const today = await redisGet(env, `today_orders:${targetRoute}`);
      const history = await redisGet(env, `history:${targetRoute}:${date}`);
      return json({ success: true, today: today || null, history: Array.isArray(history) ? history : [] });
    }

    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('orders api error', error);
    return json({ success: false, error: '订单数据服务暂不可用' }, 503);
  }
}

async function saveHistory(env, route, date, todayData) {
  const key = `history:${route}:${date}`;
  const old = await redisGet(env, key);
  let history = Array.isArray(old) ? old : [];
  const record = {
    orderBatchId: todayData.orderBatchId,
    date,
    route,
    vehicle: todayData.vehicle,
    count: todayData.count,
    weight: todayData.totalWeight,
    orders: todayData.orders,
    source: todayData.source,
    updatedAt: todayData.updatedAt
  };
  const i = history.findIndex(x => x?.orderBatchId === todayData.orderBatchId);
  if (i >= 0) history[i] = record; else history.push(record);
  if (history.length > 90) history = history.slice(-90);
  await redisSet(env, key, history);
}

function normalizeOrder(item,index,batchId){
  if(typeof item==='string') return {id:`${batchId}-${index+1}`,orderBatchId:batchId,code:String(index+1).padStart(2,'0'),name:item.trim(),nav:'',weight:0,note:'',status:'待配送'};
  const s=item||{};
  return {id:s.id||`${batchId}-${index+1}`,orderBatchId:batchId,code:String(s.code||s.index||index+1).padStart(2,'0'),name:String(s.name||s.storeName||s.shopName||s['门店名称']||'').trim(),nav:String(s.nav||s.navigation||s.url||s['导航']||'').trim(),weight:Number(s.weight??s['重量']??0)||0,note:String(s.note||s['备注']||'').trim(),status:s.status||'待配送'};
}

function createBatchId(route,date){const r=route.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g,'');const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);return `${date}-${r}-${stamp}`;}
function normalizeWeight(v){return v===null||v===undefined?'0':String(v).trim();}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s;}
function normalizeDate(v){const s=String(v||'').trim().replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-');const m=s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:'';}
async function redisGet(env,key){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`}});if(!r.ok)throw Error('Redis读取失败');const d=await r.json();if(!d.result)return null;try{return JSON.parse(d.result)}catch{return null}}
async function redisSet(env,key,value){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(value))});if(!r.ok)throw Error('Redis保存失败');}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
