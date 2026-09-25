// 天友智配One V3 · 唯一自动规划入口
import { authRequired } from './_auth.js';
import { runPlan } from './v3/core.js';

function json(data,status=200){
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}
export async function onRequest({request,env}){
  if(request.method!=='POST')return json({success:false,stage:'start',code:'METHOD_NOT_ALLOWED',message:'Method not allowed'},405);
  const session=await authRequired(request,env,{allowAnyRoute:true});
  if(!session)return json({success:false,stage:'auth',code:'AUTH_EXPIRED',message:'登录已失效'},401);
  const taskId=crypto.randomUUID();
  let body={};
  try{body=await request.json();}catch{return json({success:false,taskId,stage:'start',code:'INVALID_JSON',message:'请求数据无效'},400);}
  const started=Date.now();
  try{
    const result=await runPlan({env,session,route:body.route,date:body.date,vehicle:body.vehicle,totalWeight:body.totalWeight,text:body.text,taskId});
    return json({success:true,taskId,stage:'complete',elapsedMs:Date.now()-started,result});
  }catch(error){
    const stage=String(error?.stage||'planning'), code=String(error?.code||'PLAN_FAILED');
    console.error('V3 auto-plan failed',{taskId,stage,code,error:error?.message});
    return json({success:false,taskId,stage,code,message:error?.message||'自动规划未完成'},code==='ROUTE_FORBIDDEN'?403:500);
  }
}
