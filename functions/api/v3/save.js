// 智配One V3 · 规划结果原子保存
import { get, evalRedis } from './_redis.js';
import { planKey, latestPlanKey, todayWaybillKey, todayCorrectionKey, todayIndexKey, historyIndexKey, acquireRouteDateLock, releaseRouteDateLock, v3Key } from './data.js';

async function fingerprintOf(result){
  const stores=Array.isArray(result?.stores)?result.stores:[];
  const storeIds=stores.map(x=>String(x?.storeId||'')).filter(Boolean).sort();
  const source=[
    String(result?.route||'').trim(),
    String(result?.date||'').trim(),
    String(result?.vehicle||'').trim().toUpperCase(),
    String(result?.totalWeight||'').trim(),
    storeIds.join(',')
  ].join('|');
  const bytes=new TextEncoder().encode(source);
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest)).map(x=>x.toString(16).padStart(2,'0')).join('');
}

export async function savePlan(env,result){
 const token=crypto.randomUUID();
 if(!(await acquireRouteDateLock(env,result.route,result.date,token,30)))throw Object.assign(new Error('当前线路当天正在保存另一笔运单，请稍后重试'),{code:'ROUTE_DATE_BUSY',stage:'saving'});
 try{
  const key=planKey(result.route,result.date,result.taskId);
  const waybillKey=todayWaybillKey(result.route,result.date,result.taskId);
  const correctionKey=todayCorrectionKey(result.route,result.date,result.taskId);
  const latestKey=latestPlanKey(result.route);
  const todayIndex=todayIndexKey(result.route,result.date);
  const historyIndex=historyIndexKey(result.route,result.date);
  const fingerprint=await fingerprintOf(result);
  const duplicateKey=v3Key('route',result.route,'today',result.date,'fingerprint',fingerprint);

  const correctionData={taskId:result.taskId,route:result.route,date:result.date,orderBatchId:result.taskId,corrections:Array.isArray(result.correctionDetails)?result.correctionDetails:[],count:Number(result.corrections)||0,updatedAt:result.createdAt,schemaVersion:3};
  const script=`if redis.call('EXISTS',KEYS[1])==1 then return 'TASK_EXISTS' end
local duplicate=redis.call('GET',KEYS[2])
if duplicate then return 'DUPLICATE:'..duplicate end
redis.call('SET',KEYS[1],ARGV[1])
redis.call('SET',KEYS[3],ARGV[1])
redis.call('SET',KEYS[4],ARGV[1])
redis.call('SET',KEYS[5],ARGV[2])
redis.call('SET',KEYS[6],ARGV[3])
redis.call('SET',KEYS[7],ARGV[3])
redis.call('SET',KEYS[2],ARGV[4])
return 'OK'`;
  const outcome=await evalRedis(
    env,
    script,
    [key,duplicateKey,latestKey,waybillKey,correctionKey,todayIndex,historyIndex],
    [JSON.stringify(result),JSON.stringify(result),JSON.stringify(correctionData),result.taskId,result.taskId]
  );

  if(outcome==='TASK_EXISTS'){
    const existing=await get(env,key);
    return {saved:true,idempotent:true,key,result:existing||result};
  }
  if(outcome.startsWith('DUPLICATE:')){
    const existingTaskId=outcome.slice('DUPLICATE:'.length);
    const existing=await get(env,planKey(result.route,result.date,existingTaskId));
    return {saved:true,idempotent:true,duplicate:true,existingTaskId,key,result:existing||result};
  }
  if(outcome!=='OK')throw Object.assign(new Error('规划结果保存未确认'),{code:'SAVE_FAILED',stage:'saving'});
  return {saved:true,idempotent:false,key};
 } finally {await releaseRouteDateLock(env,result.route,result.date,token).catch(()=>{});}
}
