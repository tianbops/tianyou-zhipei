// 天友智配One V3 · 统一历史数据出口
import { authRequired } from '../_auth.js';
import { canUseRoute, normalizeRoute, getRoute, historyIndexKey, planKey } from './data.js';
import { get, evalRedis } from './_redis.js';

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
    const dates=date?[date]:[];
    if(!dates.length){
      const today=new Date();
      for(let i=0;i<HISTORY_DAYS;i++){const d=new Date(today.getTime()-i*86400000).toISOString().slice(0,10);dates.push(d);}
    }
    const taskRefs=[];
    for(const d of dates){const idx=await get(env,historyIndexKey(route,d));if(Array.isArray(idx))for(const id of idx)taskRefs.push({date:d,taskId:String(id)});}
    if(!taskRefs.length)return json({success:true,route,history:[],records:[]});
    const keys=taskRefs.map(x=>planKey(route,x.date,x.taskId));
    const raw=await evalRedis(env,"local out={}; for i,k in ipairs(KEYS) do local v=redis.call('GET',k); if v then table.insert(out,v) end end; return cjson.encode(out)",keys,[]);
    const rows=typeof raw==='string'?JSON.parse(raw):[];
    const now=Date.now();
    const records=rows.filter(x=>{
      if(!x||typeof x!=='object')return false;
      if(date&&String(x.date||'')!==date)return false;
      const t=Date.parse(String(x.date||'')); 
      return !t || now-t<=HISTORY_DAYS*86400000;
    }).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))||String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    const normalized=records.map(x=>({...x,orderBatchId:String(x.orderBatchId||x.taskId||'').trim(),orders:Array.isArray(x.orders)?x.orders:(Array.isArray(x.stores)?x.stores:[]),uniqueStoreCount:Number(x.uniqueStoreCount)||Number(x.totalStores)||((Array.isArray(x.stores)?x.stores.length:0)),count:Number(x.count)||Number(x.totalStores)||((Array.isArray(x.stores)?x.stores.length:0)),totalWeight:x.totalWeight??x.weight??'',correctionDetails:Array.isArray(x.correctionDetails)?x.correctionDetails:[],reviewCount:Number(x.reviewCount)||Number(x.pendingStores?.length)||0,newStoreCount:Number(x.newStoreCount)||Number(x.newStores?.length)||0,duplicateCount:Number(x.duplicateCount)||Number(x.merged)||0}));
    records.splice(0,records.length,...normalized);
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
