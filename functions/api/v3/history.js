// 天友智配One V3 · 统一历史数据出口
import { authRequired } from '../_auth.js';
import { canUseRoute, isRouteMaintainer, normalizeRoute, getRoute, historyIndexKey, planKey, todayWaybillKey, todayCorrectionKey, todayIndexKey, acquireRouteDateLock, releaseRouteDateLock } from './data.js';
import { get, evalRedis } from './_redis.js';

const HISTORY_DAYS=100;
export async function onRequest({request,env}){
  if(request.method!=='GET'&&request.method!=='DELETE')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env,{allowAnyRoute:true});
  if(!session)return json({success:false,error:'登录已失效'},401);
  try{
    const url=new URL(request.url);
    const route=normalizeRoute(url.searchParams.get('route'));
    const date=String(url.searchParams.get('date')||'').trim();
    const taskId=String(url.searchParams.get('taskId')||'').trim();
    if(!route)return json({success:false,error:'缺少线路'},400);
    if(!canUseRoute(session,route))return json({success:false,error:'无权使用该线路'},403);
    if(request.method==='DELETE'){
      if(!isRouteMaintainer(session,route))return json({success:false,error:'只有绑定该线路的用户可以删除历史记录'},403);
      if(!date||!taskId)return json({success:false,error:'缺少日期或运单批次'},400);
      return await deleteV3History(env,route,date,taskId);
    }
    const routeRecord=await getRoute(env,route);
    if(!routeRecord||routeRecord.status==='disabled')return json({success:false,error:'当前线路不存在或已停用'},404);
    if(taskId){
      const key=planKey(route,date,taskId);
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
    for(const d of dates){const idx=await evalRedis(env,"return redis.call('SMEMBERS',KEYS[1])",[historyIndexKey(route,d)],[]);if(Array.isArray(idx))for(const id of idx)taskRefs.push({date:d,taskId:String(id)});}
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
async function deleteV3History(env,route,date,taskId){
 const token=crypto.randomUUID();
 if(!(await acquireRouteDateLock(env,route,date,token,30)))return json({success:false,error:'该日期数据正在处理中，请稍后重试'},409);
 try{
  const key=planKey(route,date,taskId), waybillKey=todayWaybillKey(route,date,taskId), correctionKey=todayCorrectionKey(route,date,taskId), todayIdx=todayIndexKey(route,date), historyIdx=historyIndexKey(route,date);
  const script='local plan=redis.call("GET",KEYS[1]) if not plan then return "NOT_FOUND" end redis.call("DEL",KEYS[1],KEYS[2],KEYS[3]) redis.call("SREM",KEYS[4],ARGV[1]) redis.call("SREM",KEYS[5],ARGV[1]) return "OK"';
  const outcome=await evalRedis(env,script,[key,waybillKey,correctionKey,todayIdx,historyIdx,latestKey],[taskId]);
  if(outcome==='NOT_FOUND')return json({success:false,error:'历史运单不存在'},404);
  if(outcome!=='OK')throw Error('历史记录原子删除未确认');
  return json({success:true,deleted:1,route,date,taskId});
 }finally{await releaseRouteDateLock(env,route,date,token).catch(()=>{});}
}

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
