// 天友智配One V3 · 待定/新增门店确认
import { authRequired } from '../_auth.js';
import { isRouteMaintainer, getBase, getLearning, normalizeRoute, acquireRouteDateLock, releaseRouteDateLock, planKey, todayWaybillKey, todayCorrectionKey, confirmationKey, baseKey, learningKey } from './data.js';
import { get, set, evalRedis } from './_redis.js';
import { learnAlias } from './learning.js';

export async function onRequest({request,env}){
 if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
 const session=await authRequired(request,env,{allowAnyRoute:true});
 if(!session)return json({success:false,error:'登录已失效'},401);
 try{
  const body=await request.json().catch(()=>({}));
  const route=normalizeRoute(body.route),date=String(body.date||'').trim(),taskId=String(body.taskId||'').trim();
  const confirmRequestId=clean(body.confirmRequestId);
  if(!route||!date||!taskId||!confirmRequestId)return json({success:false,error:'缺少确认参数'},400);
  if(!isRouteMaintainer(session,route))return json({success:false,error:'只有绑定该线路的用户可以确认门店'},403);
  const items=Array.isArray(body.items)?body.items:[];
  if(!items.length)return json({success:false,error:'没有待确认门店'},400);

  const token=crypto.randomUUID();
  if(!(await acquireRouteDateLock(env,route,date,token,30)))return json({success:false,error:'当前线路当天正在处理另一项操作，请稍后重试'},409);
  try{
   const [plan,base,learningValue,confirmation]=await Promise.all([
    get(env,planKey(route,date,taskId)),
    getBase(env,route),
    getLearning(env,route),
    get(env,confirmationKey(route,date,taskId))
   ]);
   if(!plan)return json({success:false,error:'规划结果不存在或已失效'},404);
   if(!base)return json({success:false,error:'线路基准库不存在'},404);
   const learningOriginal=learningValue;
   let learning=learningValue;

   if(confirmation?.requestIds?.includes(confirmRequestId)){
    return json({success:true,idempotent:true,route,date,taskId,confirmed:Array.isArray(confirmation.confirmed)?confirmation.confirmed:[],storeCount:Array.isArray(base.stores)?base.stores.length:0});
   }

   let stores=Array.isArray(base.stores)?base.stores.map(x=>({...x})):[];
   const confirmedHistory=Array.isArray(confirmation?.confirmed)?confirmation.confirmed:[];
   const confirmedKeys=new Set(confirmedHistory.map(x=>matchKey(x.rawName)).filter(Boolean));
   let nextOrder=stores.reduce((m,s)=>Math.max(m,Number(s.routeOrder)||0),0)+1;
   const confirmed=[];
   for(const item of items){
    const raw=clean(item.rawName||item.name),targetId=clean(item.storeId),targetName=clean(item.baseName);
    const rawKey=matchKey(raw);
    if(!raw||!rawKey||confirmedKeys.has(rawKey))continue;
    let target=targetId?stores.find(s=>String(s.storeId)===targetId):targetName?stores.find(s=>matchKey(s.name)===matchKey(targetName)):null;
    if(!target){
      const name=targetName||raw,storeId='store-'+hash(name);
      target=stores.find(s=>String(s.storeId)===storeId);
      if(!target){target={storeId,name,routeOrder:nextOrder++,nav:'',note:''};stores.push(target);}
    }
    learning=learnAlias(learning,raw,target,{route,date});
    confirmed.push({rawName:raw,storeId:target.storeId,name:target.name,routeOrder:target.routeOrder,confirmedAt:new Date().toISOString()});
   }
   if(!confirmed.length)return json({success:true,idempotent:false,route,date,taskId,confirmed:[],storeCount:stores.length});

   stores.sort((a,b)=>Number(a.routeOrder)-Number(b.routeOrder));stores.forEach((s,i)=>s.routeOrder=i+1);
   const nextBase={...base,stores,dataVersion:Number(base.dataVersion||0)+1,updatedAt:new Date().toISOString(),updatedBy:session.id,schemaVersion:3};
   const nextLearning={...learning,updatedAt:new Date().toISOString(),updatedBy:session.id,schemaVersion:3};
   const confirmedStoreIds=new Set(confirmed.map(x=>String(x.storeId||'')).filter(Boolean));
   const confirmedRawKeys=new Set(confirmed.map(x=>matchKey(x.rawName)).filter(Boolean));
   const isConfirmedPlanItem=p=>confirmedStoreIds.has(String(p?.storeId||''))||confirmedRawKeys.has(matchKey(p?.rawName||p?.name));
   // 确认后的待定/新增门店必须转入当前规划的正式 stores。
   const oldStores=Array.isArray(plan.stores)?plan.stores:[];
   const pendingPlan=[...(Array.isArray(plan.pendingStores)?plan.pendingStores:[]),...(Array.isArray(plan.newStores)?plan.newStores:[])];
   const promoted=[];
   for(const c of confirmed){
    const source=pendingPlan.find(p=>isConfirmedPlanItem(p)&&String(p?.storeId||'')===String(c.storeId||'')) || pendingPlan.find(p=>isConfirmedPlanItem(p)&&matchKey(p?.rawName||p?.name)===matchKey(c.rawName));
    const baseStore=stores.find(s=>String(s.storeId)===String(c.storeId));
    if(!baseStore)continue;
    promoted.push({...((source&&typeof source==='object')?source:{}),...baseStore,storeId:baseStore.storeId,name:baseStore.name,originalName:clean(source?.originalName||source?.rawName||c.rawName)||c.rawName,rawName:clean(source?.rawName||c.rawName)||c.rawName,routeOrder:Number(baseStore.routeOrder)||0,corrected:matchKey(source?.rawName||source?.originalName||c.rawName)!==matchKey(baseStore.name),matchConfidence:Number(source?.matchConfidence)||1,matchVia:source?.matchVia||'confirmed'});
   }
   const byStoreId=new Map();
   for(const s of oldStores)if(s?.storeId)byStoreId.set(String(s.storeId),{...s});
   for(const s of promoted)if(s?.storeId)byStoreId.set(String(s.storeId),s);
   const nextStores=[...byStoreId.values()].filter(s=>s?.storeId&&stores.some(b=>String(b.storeId)===String(s.storeId))).map(s=>{const b=stores.find(x=>String(x.storeId)===String(s.storeId));return {...s,routeOrder:Number(b?.routeOrder)||Number(s.routeOrder)||0,name:b?.name||s.name};}).sort((a,b)=>Number(a.routeOrder)-Number(b.routeOrder));
   const nextPending=Array.isArray(plan.pendingStores)?plan.pendingStores.filter(p=>!isConfirmedPlanItem(p)):[];
   const nextNew=Array.isArray(plan.newStores)?plan.newStores.filter(p=>!isConfirmedPlanItem(p)):[];
   const nextCorrections=nextStores.filter(x=>x.corrected).length;
   const nextCorrectionDetails=nextStores.filter(x=>x.corrected).map(x=>({storeId:x.storeId,originalName:x.originalName,name:x.name,routeOrder:x.routeOrder,matchConfidence:x.matchConfidence,matchVia:x.matchVia}));
   const nextRawCount=Number(plan.rawCount)||nextStores.length+nextPending.length+Number(plan.merged)||0;
   const nextPlan={...plan,stores:nextStores,pendingStores:nextPending,newStores:nextNew,rawCount:nextRawCount,totalStores:nextStores.length+nextPending.length,corrections:nextCorrections,merged:Math.max(0,nextRawCount-nextStores.length-nextPending.length),routeOrder:nextStores.map(x=>x.storeId),correctionDetails:nextCorrectionDetails,updatedAt:new Date().toISOString()};
   const nextConfirmation={
    route,date,taskId,schemaVersion:3,
    requestIds:[...(Array.isArray(confirmation?.requestIds)?confirmation.requestIds:[]),confirmRequestId].slice(-50),
    confirmed:[...confirmedHistory,...confirmed],
    updatedAt:new Date().toISOString(),updatedBy:session.id
   };
   const script="if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] or redis.call('GET',KEYS[3])~=ARGV[3] or redis.call('GET',KEYS[4])~=ARGV[4] then return 'CONFLICT' end redis.call('SET',KEYS[1],ARGV[5]) redis.call('SET',KEYS[2],ARGV[6]) redis.call('SET',KEYS[3],ARGV[7]) redis.call('SET',KEYS[4],ARGV[8]) return 'OK'";
   const oldBase=JSON.stringify(base),oldLearning=JSON.stringify(learningOriginal),oldConfirmation=JSON.stringify(confirmation||null),oldPlan=JSON.stringify(plan);
   const outcome=await evalRedis(env,script,[baseKey(route),learningKey(route),confirmationKey(route,date,taskId),planKey(route,date,taskId)],[oldBase,oldLearning,oldConfirmation,oldPlan,JSON.stringify(nextBase),JSON.stringify(nextLearning),JSON.stringify(nextConfirmation),JSON.stringify(nextPlan)]);
   if(outcome==='CONFLICT')throw Object.assign(new Error('基准库刚刚发生变化，请刷新后重新确认'),{code:'CONFIRM_CONFLICT'});
   if(outcome!=='OK')throw Object.assign(new Error('门店确认保存未确认'),{code:'CONFIRM_SAVE_FAILED'});
   // 同一确认操作持有线路-日期锁；保存成功后同步今日线路快照，避免规划与今日线路显示不一致。
   const correctionData={taskId,route,date,orderBatchId:taskId,corrections:nextCorrectionDetails,count:nextCorrections,updatedAt:nextPlan.updatedAt,schemaVersion:3};
   await set(env,todayWaybillKey(route,date,taskId),nextPlan);
   await set(env,todayCorrectionKey(route,date,taskId),correctionData);
   return json({success:true,idempotent:false,route,date,taskId,confirmed,storeCount:stores.length,confirmedAt:nextConfirmation.updatedAt});
  }finally{await releaseRouteDateLock(env,route,date,token).catch(()=>{});}
 }catch(e){
  console.error('V3 pending confirmation error',e);
  return json({success:false,error:e?.message||'门店确认失败',code:e?.code||'CONFIRM_FAILED'},e?.code==='CONFIRM_CONFLICT'?409:503);
 }
}
function clean(v){return String(v||'').replace(/\s+/g,' ').trim().slice(0,200);}
function matchKey(v){return clean(v).replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g,'').toLowerCase();}
function hash(v){let h=2166136261;for(const c of String(v))h=Math.imul(h^c.charCodeAt(0),16777619);return (h>>>0).toString(36);}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}

