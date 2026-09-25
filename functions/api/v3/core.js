// 天友智配One V3 · 一体化规划编排器

import { getRoute, getBase, getLearning, normalizeRoute, canUseRoute } from './data.js';
import { extractStores } from './extract.js';
import { matchStores } from './match.js';
import { dedupeStores } from './dedupe.js';
import { routePlan } from './route-plan.js';
import { savePlan } from './save.js';
function dateValue(v){const s=String(v||'').trim();return /^\d{4}-\d{2}-\d{2}$/.test(s)?s:'';}
export async function runPlan({env,session,route,date,vehicle,totalWeight,text,taskId}){
 route=normalizeRoute(route);
 const ocrVersion='PP-OCRv6',ocrModel='PP-OCRv6-small';
 if(!route)throw Object.assign(new Error('未指定配送线路'),{code:'ROUTE_REQUIRED',stage:'matching'});
 if(!canUseRoute(session,route))throw Object.assign(new Error('无权使用该线路'),{code:'ROUTE_FORBIDDEN',stage:'matching'});
 const routeRecord=await getRoute(env,route);
 if(!routeRecord||routeRecord.status==='disabled')throw Object.assign(new Error('线路不存在或已停用'),{code:'ROUTE_NOT_FOUND',stage:'matching'});
 const [base,learning]=await Promise.all([getBase(env,route),getLearning(env,route)]);
 if(!base)throw Object.assign(new Error('线路基准库不存在'),{code:'BASE_MISSING',stage:'matching'});
 const candidates=extractStores(text);
 if(!candidates.length)throw Object.assign(new Error('未提取到有效门店'),{code:'EXTRACT_FAILED',stage:'extracting'});
 const finalDate=dateValue(date)||new Date().toISOString().slice(0,10);
 const matched=matchStores(candidates,base,learning,{route,date:finalDate});
 const deduped=dedupeStores(matched.matched,candidates,matched.pendingStores);
 const planned=routePlan(deduped.stores,deduped.pendingStores);
 const result={taskId,route,date:finalDate,vehicle:String(vehicle??'').trim(),totalWeight:String(totalWeight??'').trim(),stores:planned.plannedStores,pendingStores:planned.pendingStores,newStores:planned.pendingStores,rawCount:deduped.rawCount,totalStores:deduped.totalStores,corrections:planned.plannedStores.filter(x=>x.corrected).length,merged:deduped.merged,routeOrder:planned.routeOrder,correctionDetails:planned.plannedStores.filter(x=>x.corrected).map(x=>({storeId:x.storeId,originalName:x.originalName,name:x.name,routeOrder:x.routeOrder,matchConfidence:x.matchConfidence,matchVia:x.matchVia})),createdAt:new Date().toISOString(),schemaVersion:3,ocrVersion,ocrModel};
 await savePlan(env,result);
 return result;
}