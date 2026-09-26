// 智配One V3 · 一体化规划编排器

import { getRoute, getBase, getLearning, normalizeRoute, canUseRoute } from './data.js';
import { extractStores } from './extract.js';
import { matchStores } from './match.js';
import { dedupeStores } from './dedupe.js';
import { routePlan } from './route-plan.js';
import { savePlan } from './save.js';
function dateValue(v){const s=String(v||'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:'';}
function businessDate(){
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());
 const getPart=t=>String(parts.find(p=>p.type===t)?.value||'').padStart(2,'0');
 return `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
}
export async function runPlan({env,session,route,date,vehicle,totalWeight,text,taskId}){
 route=normalizeRoute(route);
 const ocrVersion='PP-OCRv6',ocrModel='PP-OCRv6-small';
 if(!route)throw Object.assign(new Error('未指定配送线路'),{code:'ROUTE_REQUIRED',stage:'matching'});
 if(!canUseRoute(session,route))throw Object.assign(new Error('无权使用该线路'),{code:'ROUTE_FORBIDDEN',stage:'matching'});
 const routeRecord=await getRoute(env,route);
 if(!routeRecord||routeRecord.status==='disabled')throw Object.assign(new Error('线路不存在或已停用'),{code:'ROUTE_NOT_FOUND',stage:'matching'});
 const [base,learning]=await Promise.all([getBase(env,route),getLearning(env,route)]);
 const baseDatabaseAvailable=Array.isArray(base?.stores)&&base.stores.length>0;
 let candidates;
 try{ candidates=extractStores(text); }
 catch(error){ throw Object.assign(new Error(error?.message||'运单文字提取失败'),{code:error?.code||'EXTRACT_FAILED',stage:'extracting'}); }
 if(!candidates.length)throw Object.assign(new Error('未提取到有效门店'),{code:'EXTRACT_FAILED',stage:'extracting'});
 const finalDate=dateValue(date)||businessDate();
 let matched={matched:[],pendingStores:[]};
 let deduped;
 if(baseDatabaseAvailable){
   try{ matched=matchStores(candidates,base,learning,{route,date:finalDate}); }
   catch(error){ throw Object.assign(new Error(error?.message||'门店匹配未完成'),{code:error?.code||'MATCH_FAILED',stage:'matching'}); }
   try{ deduped=dedupeStores(matched.matched,candidates,matched.pendingStores); }
   catch(error){ throw Object.assign(new Error(error?.message||'门店整理未完成'),{code:error?.code||'MATCH_FAILED',stage:'matching'}); }
 }else{
   // 无基准库：不强行匹配、不生成“新增门店”，直接按OCR提取顺序形成临时运单门店记录并保存。
   // RAW-* 仅属于本次运单，不进入基准库，也不作为后续门店身份。
   const rawStores=candidates.map((name,index)=>({
     storeId:'RAW-'+String(index+1).padStart(4,'0'),
     name:String(name).trim(),
     originalName:String(name).trim(),
     routeOrder:index+1,
     corrected:false,
     matchConfidence:0,
     matchVia:'raw-order',
     nav:'',
     needsReview:false,
     provisional:true
   }));
   deduped={stores:rawStores,rawCount:candidates.length,totalStores:rawStores.length,merged:0};
 }
 let planned;
 try{ planned=routePlan(deduped.stores,deduped.pendingStores); }
 catch(error){ throw Object.assign(new Error(error?.message||'配送顺序生成失败'),{code:error?.code||'PLAN_FAILED',stage:'planning'}); }
 // 核心保护：规划器必须返回完整、可保存的结构；不得让异常结果继续进入保存链路
 if(!planned||!Array.isArray(planned.plannedStores)||!Array.isArray(planned.pendingStores)||!Array.isArray(planned.routeOrder)){
   throw Object.assign(new Error('配送顺序生成结果无效'),{code:'PLAN_FAILED',stage:'planning'});
 }
 const invalidStore=planned.plannedStores.find(x=>!x||!String(x.storeId||'').trim()||!Number.isFinite(Number(x.routeOrder)));
 if(invalidStore){
   throw Object.assign(new Error('配送顺序包含无效门店数据'),{code:'PLAN_FAILED',stage:'planning'});
 }
 const invalidPending=planned.pendingStores.find(x=>!x||!String(x.name||'').trim());
 if(invalidPending){
   throw Object.assign(new Error('待定门店数据无效'),{code:'PLAN_FAILED',stage:'planning'});
 }
 const allIds=new Set(planned.plannedStores.map(x=>String(x.storeId)));
 if(planned.pendingStores.some(x=>x.storeId&&allIds.has(String(x.storeId)))){
   throw Object.assign(new Error('待定门店与已规划门店重复'),{code:'PLAN_FAILED',stage:'planning'});
 }
 if(planned.routeOrder.length!==planned.plannedStores.length||planned.routeOrder.some((id,i)=>String(id)!==String(planned.plannedStores[i].storeId))){
   throw Object.assign(new Error('配送顺序与门店数据不一致'),{code:'PLAN_FAILED',stage:'planning'});
 }
 const result={taskId,route,date:finalDate,vehicle:String(vehicle??'').trim(),totalWeight:String(totalWeight??'').trim(),stores:planned.plannedStores,pendingStores:planned.pendingStores,newStores:baseDatabaseAvailable?planned.pendingStores:[],rawCount:deduped.rawCount,totalStores:deduped.totalStores,corrections:baseDatabaseAvailable?planned.plannedStores.filter(x=>x.corrected).length:0,merged:deduped.merged,routeOrder:planned.routeOrder,baseDatabaseAvailable,correctionDetails:planned.plannedStores.filter(x=>x.corrected).map(x=>({storeId:x.storeId,originalName:x.originalName,name:x.name,routeOrder:x.routeOrder,matchConfidence:x.matchConfidence,matchVia:x.matchVia})),createdAt:new Date().toISOString(),schemaVersion:3,ocrVersion,ocrModel};
 let saved;
 try{ saved=await savePlan(env,result); }
 catch(error){ throw Object.assign(new Error(error?.message||'规划结果保存失败'),{code:error?.code||'SAVE_FAILED',stage:'saving'}); }
 if(saved?.result){
   return {
     ...saved.result,
     idempotent:Boolean(saved.idempotent),
     duplicate:Boolean(saved.duplicate),
     existingTaskId:saved.existingTaskId||saved.result.taskId
   };
 }
 return result;
}