// 天友智配One V3 · 待定/新增门店确认
import { authRequired } from '../_auth.js';
import { isRouteMaintainer, getBase, getLearning, setBase, setLearning, normalizeRoute, acquireRouteDateLock, releaseRouteDateLock } from './data.js';
import { get } from './_redis.js';
export async function onRequest({request,env}){
 if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
 const session=await authRequired(request,env,{allowAnyRoute:true});
 if(!session)return json({success:false,error:'登录已失效'},401);
 try{
  const body=await request.json().catch(()=>({})),route=normalizeRoute(body.route),date=String(body.date||'').trim(),taskId=String(body.taskId||'').trim();
  if(!route||!date||!taskId)return json({success:false,error:'缺少确认参数'},400);
  if(!isRouteMaintainer(session,route))return json({success:false,error:'只有绑定该线路的用户可以确认门店'},403);
  const plan=await get(env,'zpei:v3:route:'+encodeURIComponent(route)+':plan:'+encodeURIComponent(date)+':'+encodeURIComponent(taskId));
  if(!plan)return json({success:false,error:'规划结果不存在或已失效'},404);
  const items=Array.isArray(body.items)?body.items:[];
  if(!items.length)return json({success:false,error:'没有待确认门店'},400);
  const base=await getBase(env,route);if(!base)return json({success:false,error:'线路基准库不存在'},404);
  const learning=await getLearning(env,route);
  const stores=Array.isArray(base.stores)?base.stores.map(x=>({...x})):[],aliases={...(learning.aliases||{})};
  let nextOrder=stores.reduce((m,s)=>Math.max(m,Number(s.routeOrder)||0),0)+1;
  const confirmed=[];
  for(const item of items){
   const raw=clean(item.rawName||item.name), targetId=clean(item.storeId), targetName=clean(item.baseName);
   if(!raw)continue;
   let target=targetId?stores.find(s=>String(s.storeId)===targetId):targetName?stores.find(s=>matchKey(s.name)===matchKey(targetName)):null;
   if(!target){
    const name=targetName||raw,storeId='store-'+hash(name);
    if(stores.some(s=>String(s.storeId)===storeId))target=stores.find(s=>String(s.storeId)===storeId);
    else{target={storeId,name,routeOrder:nextOrder++,nav:'',note:''};stores.push(target);}
   }
   const ak=matchKey(raw),bk=matchKey(target.name);
   if(ak&&bk&&ak!==bk)aliases[ak]={baseKey:bk,storeId:String(target.storeId),baseName:target.name,count:Math.max(1,Number(aliases[ak]?.count)||0)+1,updatedAt:new Date().toISOString(),rawExamples:[...new Set([...(aliases[ak]?.rawExamples||[]),raw])].slice(-3)};
   confirmed.push({rawName:raw,storeId:target.storeId,name:target.name,routeOrder:target.routeOrder});
  }
  const token=crypto.randomUUID();if(!(await acquireRouteDateLock(env,route,date,token,30)))return json({success:false,error:'当前线路当天正在处理另一项操作，请稍后重试'},409);
  try{
   stores.sort((a,b)=>Number(a.routeOrder)-Number(b.routeOrder));stores.forEach((s,i)=>s.routeOrder=i+1);
   await setBase(env,route,{...base,stores,dataVersion:Number(base.dataVersion||0)+1,updatedAt:new Date().toISOString(),updatedBy:session.id});
   await setLearning(env,route,{...learning,aliases,updatedAt:new Date().toISOString(),updatedBy:session.id});
  }finally{await releaseRouteDateLock(env,route,date,token).catch(()=>{});}
  return json({success:true,route,date,taskId,confirmed,storeCount:stores.length});
 }catch(e){console.error('V3 pending confirmation error',e);return json({success:false,error:e?.message||'门店确认失败'},503);}
}
function clean(v){return String(v||'').replace(/\s+/g,' ').trim().slice(0,200);}
function matchKey(v){return clean(v).replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g,'').toLowerCase();}
function hash(v){let h=2166136261;for(const c of String(v))h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0).toString(36);}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
