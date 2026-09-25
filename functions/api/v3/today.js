// 天友智配One V3 · 今日运单/今日修正数据调用接口
import { authRequired } from '../_auth.js';
import { canUseRoute, normalizeRoute, todayWaybillKey, todayCorrectionKey, planKey } from './data.js';
import { get, evalRedis, v3Key } from './_redis.js';

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
    if(!canUseRoute(session,route))return json({success:false,error:'无权使用该线路'},403);\n    const routeRecord=await getRoute(env,route);\n    if(!routeRecord||routeRecord.status==='disabled')return json({success:false,error:'当前线路不存在或已停用'},404);
    if(taskId){
      const [waybill,corrections]=await Promise.all([
        get(env,todayWaybillKey(route,date,taskId)),
        get(env,todayCorrectionKey(route,date,taskId))
      ]);
      if(!waybill)return json({success:false,error:'今日运单数据不存在'},404);
      return json({success:true,route,date,taskId,waybill,corrections:corrections||{taskId,route,date,corrections:[],count:0,schemaVersion:3}});
    }
    const pattern=v3Key('route',route,'today',date,'waybill','*');
    const rows=await evalRedis(env,"local keys=redis.call('KEYS',ARGV[1]); local out={}; for _,k in ipairs(keys) do local v=redis.call('GET',k); if v then table.insert(out,v) end end; return cjson.encode(out)",[],[pattern]);
    const waybills=typeof rows==='string'?JSON.parse(rows):[];
    if(!waybills.length)return json({success:true,route,date,waybills:[],todayWaybillCount:0,todaySummary:{storeCount:0,totalWeight:''}});
    waybills.sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
    const totalWeight=waybills.reduce((sum,x)=>{const m=String(x.totalWeight||'').match(/[\\d.]+/);return sum+(m?Number(m[0]):0)},0);
    const storeCount=waybills.reduce((sum,x)=>sum+Number(x.totalStores||x.stores?.length||0),0);
    return json({success:true,route,date,waybills,today:waybills[0],todayWaybillCount:waybills.length,todaySummary:{storeCount,totalWeight:totalWeight?totalWeight+'t':''}});
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
