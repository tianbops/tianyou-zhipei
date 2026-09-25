// 天友智配One V3 · 今日运单/今日修正数据调用接口
import { authRequired } from '../_auth.js';
import { canUseRoute, normalizeRoute, todayWaybillKey, todayCorrectionKey } from './data.js';
import { get } from './_redis.js';

export async function onRequest({request,env}){
  if(request.method!=='GET')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env,{allowAnyRoute:true});
  if(!session)return json({success:false,error:'登录已失效'},401);
  try{
    const url=new URL(request.url);
    const route=normalizeRoute(url.searchParams.get('route'));
    const date=String(url.searchParams.get('date')||'').trim();
    const taskId=String(url.searchParams.get('taskId')||'').trim();
    if(!route||!date||!taskId)return json({success:false,error:'缺少线路、日期或运单任务编号'},400);
    if(!canUseRoute(session,route))return json({success:false,error:'无权使用该线路'},403);
    const [waybill,corrections]=await Promise.all([
      get(env,todayWaybillKey(route,date,taskId)),
      get(env,todayCorrectionKey(route,date,taskId))
    ]);
    if(!waybill)return json({success:false,error:'今日运单数据不存在'},404);
    return json({success:true,route,date,taskId,waybill,corrections:corrections||{taskId,route,date,corrections:[],count:0,schemaVersion:3}});
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
