// functions/api/routes.js
import { authRequired } from './_auth.js';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const route = normalizeRoute(url.searchParams.get('route'));
  const method = request.method;
  if (!route) return json({error:'Missing route parameter'},400);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({error:'Redis not configured'},500);

  const session = await authRequired(request, env, { route });
  if (!session) return json({error:'未登录或无权访问该线路'},401);
  const key = `route:${route}`;

  try {
    if (method === 'GET') {
      const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`}});
      if (!r.ok) return json({route,stores:[]});
      const d = await r.json(); let stores=[];
      if(d.result){try{const p=JSON.parse(d.result);stores=Array.isArray(p?.stores)?p.stores:[]}catch{}}
      return json({route,stores});
    }
    if (method === 'PUT') {
      const body=await request.json();
      if(!Array.isArray(body.stores))return json({error:'stores 必须是数组'},400);
      const value=JSON.stringify({route,stores:body.stores,updatedAt:new Date().toISOString()});
      const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(value)});
      if(!r.ok)return json({error:'Failed to save route'},500);
      return json({success:true,route,storeCount:body.stores.length});
    }
    return json({error:'Method not allowed'},405);
  } catch(e){console.error('routes api error',e);return json({error:'线路数据服务异常'},500)}
}
function normalizeRoute(v){const s=String(v||'').trim();const m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
