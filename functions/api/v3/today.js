// 智配One V3 · 今日运单/今日修正数据调用接口
import { authRequired } from '../_auth.js';
import { canUseRoute, normalizeRoute, todayWaybillKey, todayCorrectionKey, todayIndexKey, getRoute } from './data.js';
import { get, evalRedis } from './_redis.js';
import { waybillMetrics } from './metrics.js';

export async function onRequest({request,env}){
  if(request.method!=='GET')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env,{allowAnyRoute:true});
  if(!session)return json({success:false,error:'登录已失效'},401);
  try{
    const url=new URL(request.url);
    const route=normalizeRoute(url.searchParams.get('route'));
    const date=String(url.searchParams.get('date')||'').trim();
    const taskId=String(url.searchParams.get('taskId')||'').trim();
    if(!route||!date)return json({success:false,error:'缺少线路或日期'},400);
    if(!canUseRoute(session,route))return json({success:false,error:'无权使用该线路'},403);
    const routeRecord=await getRoute(env,route);
    if(!routeRecord||routeRecord.status==='disabled')return json({success:false,error:'当前线路不存在或已停用'},404);
    if(taskId){
      const [waybill,corrections]=await Promise.all([
        get(env,todayWaybillKey(route,date,taskId)),
        get(env,todayCorrectionKey(route,date,taskId))
      ]);
      if(!waybill)return json({success:false,error:'今日运单数据不存在'},404);
      return json({success:true,route,date,taskId,waybill,corrections:corrections||{taskId,route,date,corrections:[],count:0,schemaVersion:3}});
    }
    const rawIndex=await evalRedis(env,"return redis.call('SMEMBERS',KEYS[1])",[todayIndexKey(route,date)],[]);
    const taskIds=Array.isArray(rawIndex)?rawIndex:[];
    if(!taskIds.length)return json({success:true,route,date,waybills:[],todayWaybillCount:0,todaySummary:{storeCount:0,totalWeight:''}});
    const rows=await evalRedis(env,"local out={}; for i,k in ipairs(KEYS) do local v=redis.call('GET',k); if v then table.insert(out,v) end end; return cjson.encode(out)",[...taskIds.map(id=>todayWaybillKey(route,date,id))],[]);
    const waybills=typeof rows==='string'?JSON.parse(rows):[];
    if(!waybills.length)return json({success:true,route,date,waybills:[],todayWaybillCount:0,todaySummary:{storeCount:0,totalWeight:''}});
    waybills.sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
    const metrics=waybillMetrics(waybills);
    return json({success:true,route,date,waybills,today:waybills[0],todayWaybillCount:metrics.waybillCount,todaySummary:metrics});
  }catch(e){
    console.error('V3 today data error',e);
    return json({success:false,error:e?.message||'今日数据读取失败'},503);
  }
}
function json(data,status=200){
  return new Response(JSON.stringify(data),{
    status,
    headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}
  });
}
