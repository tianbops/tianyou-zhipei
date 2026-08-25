// 历史查询 API：服务器为唯一真实数据源。
import { authRequired } from './_auth.js';
export async function onRequest(context){
 const {request,env}=context;
 if(request.method!=='GET')return json({error:'Method not allowed'},405);
 if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN)return json({error:'Redis not configured'},500);
 const session=await authRequired(request,env); if(!session)return json({error:'登录已失效或无权限'},401);
 const url=new URL(request.url); const date=normalizeDate(url.searchParams.get('date')); if(!date)return json({error:'Missing date parameter'},400);
 const requested=normalizeRoute(url.searchParams.get('route')||''); const route=session.role==='admin'?requested:normalizeRoute(session.route);
 if(!route)return json({error:'用户未绑定线路'},403);
 try{
  const key=`history:${route}:${date}`;
  const resp=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`},cache:'no-store'});
  if(!resp.ok)return json({error:'历史数据读取失败'},502);
  const body=await resp.json(); let result=[];
  if(body.result){try{result=JSON.parse(body.result)}catch{result=[]}}
  return json(Array.isArray(result)?result:[]);
 }catch(e){return json({error:'历史数据服务异常'},500)}
}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function normalizeDate(v){const s=String(v||'').trim().replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-');const m=s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:''}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
