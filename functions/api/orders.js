// 天友智配One - 服务器端订单 API
// 服务器为真实数据源；订单按「线路 + 业务日期」独立存储。
// 服务器保存前再次按对应线路基准库排序，防止客户端篡改顺序。
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
      const requestedRoute = normalizeRoute(body.route);
      const targetRoute = session.role === 'admin' ? (requestedRoute || sessionRoute) : sessionRoute;
      if (!targetRoute || !Array.isArray(body.orders)) return json({ error: '缺少线路或订单数据' }, 400);

      const date = normalizeDate(body.date) || businessDate();
      const key = `today_orders:${targetRoute}:${date}`;
      const existing = await redisGet(env, key);
      const suppliedBatchId = String(body.orderBatchId || '').trim();
      const orderBatchId = suppliedBatchId || existing?.orderBatchId || createBatchId(targetRoute, date);
      const updatedAt = new Date().toISOString();
      let normalizedOrders = body.orders.map((item, index) => normalizeOrder(item, index, orderBatchId, targetRoute, date)).filter(item => item.name);

      // 最终顺序由服务器根据该线路独立基准库决定：基准门店按 routeOrder，新增门店统一置底。
      const base = await loadBaseData(env, targetRoute);
      normalizedOrders = sortByRouteBase(normalizedOrders, base);

      const todayData = {
        orderBatchId, date, route: targetRoute,
        vehicle: String(body.vehicle || '').trim(), orders: normalizedOrders,
        totalWeight: normalizeWeight(body.totalWeight), count: normalizedOrders.length,
        matchedCount: Number(body.matchedCount) || normalizedOrders.filter(x => x.matched === true).length,
        newStoreCount: Number(body.newStoreCount) || normalizedOrders.filter(x => x.isNew === true).length,
        recognizedCount: Number(body.recognizedCount) || normalizedOrders.length,
        rawOrderCount: Number(body.rawOrderCount) || 0,
        source: body.source || 'web', updatedAt
      };

      await redisSet(env, key, todayData);
      await saveHistory(env, targetRoute, date, todayData);
      return json({ success: true, data: todayData });
    }

    if (request.method === 'GET') {
      const url = new URL(request.url);
      const requestedRoute = normalizeRoute(url.searchParams.get('route') || '');
      const targetRoute = session.role === 'admin' ? (requestedRoute || sessionRoute) : sessionRoute;
      if (!targetRoute) return json({ error: '缺少线路' }, 400);
      const date = normalizeDate(url.searchParams.get('date')) || businessDate();
      const today = await redisGet(env, `today_orders:${targetRoute}:${date}`);
      const history = await redisGet(env, `history:${targetRoute}:${date}`);
      return json({ success: true, today: today && normalizeDate(today.date) === date ? today : null, history: Array.isArray(history) ? history : [] });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('orders api error', error);
    return json({ success: false, error: '订单数据服务暂不可用' }, 503);
  }
}

async function loadBaseData(env, route) {
  const raw = await redisGet(env, `route:${route}:base`);
  const stores = Array.isArray(raw?.stores) ? raw.stores : [];
  return stores.map((s, index) => ({
    ...s,
    routeOrder: Number(s?.routeOrder || s?.code || index + 1) || index + 1,
    nameKey: normalizeStoreName(s?.name || s?.storeName || s?.shopName || s?.['门店名称'])
  })).filter(s => s.nameKey);
}

function sortByRouteBase(orders, base) {
  if (!base.length) return orders;
  const orderMap = new Map(base.map((s, index) => [s.nameKey, Number(s.routeOrder) || index + 1]));
  return orders.map((order, index) => {
    const key = normalizeStoreName(order.name);
    const routeOrder = orderMap.get(key);
    return {
      ...order,
      routeOrder: routeOrder || null,
      // 服务器最终以基准库匹配结果为准，避免客户端伪造 matched/isNew 破坏顺序。
      matched: routeOrder != null,
      isNew: routeOrder == null
    };
  }).sort((a, b) => {
    const ar = Number(a.routeOrder || Number.MAX_SAFE_INTEGER);
    const br = Number(b.routeOrder || Number.MAX_SAFE_INTEGER);
    if (ar !== br) return ar - br;
    return a.__inputIndex - b.__inputIndex;
  }).map(({ __inputIndex, ...item }) => item);
}

async function saveHistory(env, route, date, todayData) {
  const key = `history:${route}:${date}`;
  const old = await redisGet(env, key);
  let history = Array.isArray(old) ? old : [];
  const record = { orderBatchId: todayData.orderBatchId, date, route, vehicle: todayData.vehicle, count: todayData.count, weight: todayData.totalWeight, totalWeight: todayData.totalWeight, matchedCount: todayData.matchedCount, newStoreCount: todayData.newStoreCount, recognizedCount: todayData.recognizedCount, rawOrderCount: todayData.rawOrderCount, orders: todayData.orders, source: todayData.source, updatedAt: todayData.updatedAt };
  const i = history.findIndex(x => x?.orderBatchId === todayData.orderBatchId);
  if (i >= 0) history[i] = record; else history.push(record);
  if (history.length > 90) history = history.slice(-90);
  await redisSet(env, key, history);
}

function normalizeOrder(item,index,batchId,route,date){
  if(typeof item==='string') return {id:`${batchId}-${index+1}`,orderBatchId:batchId,code:String(index+1).padStart(2,'0'),name:item.trim(),nav:'',weight:0,note:'',matched:false,isNew:false,status:'待配送',route,date,__inputIndex:index};
  const s=item||{};
  return {id:s.id||`${batchId}-${index+1}`,orderBatchId:batchId,code:String(s.code||s.index||index+1).padStart(2,'0'),name:String(s.name||s.storeName||s.shopName||s['门店名称']||'').trim(),nav:String(s.nav||s.navigation||s.url||s['导航']||'').trim(),weight:Number(s.weight??s['重量']??0)||0,note:String(s.note||s['备注']||'').trim(),matched:s.matched===true,isNew:s.isNew===true||s.newStore===true,status:s.status||'待配送',route,date,__inputIndex:index};
}
function createBatchId(route,date){const r=route.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g,'');const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);return `${date}-${r}-${stamp}`;}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim();const m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return /吨|\bt\b/i.test(s)?`${n}t`:`${n}kg`;}
function normalizeStoreName(v){return String(v||'').trim().replace(/[\s\u3000]+/g,'').replace(/[（）()【】\[\]{}]/g,'').toLowerCase();}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s;}
function normalizeDate(v){const s=String(v||'').trim().replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-');const m=s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:'';}
function businessDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
async function redisGet(env,key){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`},cache:'no-store'});if(!r.ok)throw Error('Redis读取失败');const d=await r.json();if(!d.result)return null;try{return JSON.parse(d.result)}catch{return null}}
async function redisSet(env,key,value){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(value)),cache:'no-store'});if(!r.ok)throw Error('Redis保存失败');const d=await r.json().catch(()=>({}));if(d.result!==undefined&&d.result!=='OK')throw Error('Redis保存未确认');}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
