// 天友智配One V3 · 统一历史数据出口
import { authRequired } from '../_auth.js';
import { canUseRoute, normalizeRoute, getRoute } from './data.js';
import { evalRedis, v3Key } from './_redis.js';

const HISTORY_DAYS=100;
export async function onRequest({request,env}){
  if(request.method!=='GET')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env,{allowAnyRoute:true});
  if(!session)return json({success:false,error:'登录已失效'},401);
  try{
    const url=new URL(request.url);
    const route=normalizeRoute(url.searchParams.get('route'));
    const date=String(url.searchParams.get('date')||'').trim();
    const taskId=String(url.searchParams.get('taskId')||'').trim();
    if(!route)return json({success:false,error:'缺少线路'},400);
    if(!canUseRoute(session,route))return json({success:false,error:'无权使用该线路'},403);
    const routeRecord=await getRoute(env,route);
    if(!routeRecord||routeRecord.status==='disabled')return json({success:false,error:'当前线路不存在或已停用'},404);
    if(taskId){
      const key=v3Key('route',route,'plan',date,taskId);
      const one=await evalRedis(env,"local v=redis.call('GET',KEYS[1]); return v or ''",[key],[]);
      if(!one)return json({success:false,error:'历史运单不存在'},404);
      return json({success:true,route,date,taskId,record:JSON.parse(one)});
    }
    const pattern=v3Key('route',route,'plan','*','*');
    const raw=await evalRedis(env,"local keys=redis.call('KEYS',ARGV[1]); local out={}; for _,k in ipairs(keys) do local v=redis.call('GET',k); if v then table.insert(out,v) end end; return cjson.encode(out)",[],[pattern]);
    const rows=typeof raw==='string'?JSON.parse(raw):[];
    const now=Date.now();
    const records=rows.filter(x=>{
      if(!x||typeof x!=='object')return false;
      if(date&&String(x.date||'')!==date)return false;
      const t=Date.parse(String(x.date||'')); 
      return !t || now-t<=HISTORY_DAYS*86400000;
    }).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    const groups=new Map();
    for(const x of records){
      const d=String(x.date||'');
      if(!groups.has(d))groups.set(d,[]);
      groups.get(d).push(x);
    }
    return json({success:true,route,history:[...groups.entries()].map(([d,items])=>({date:d,records:items})),records});
  }catch(e){
    console.error('V3 history error',e);
    return json({success:false,error:e?.message||'历史数据读取失败'},503);
  }
}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
