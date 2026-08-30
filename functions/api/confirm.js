// 天友智配One - 运单确认入库 API
// 解析结果与正式订单分离：只有确认后的数据才能进入今日订单。
import { authRequired } from './_auth.js';

export async function onRequest({request,env}){
  const session=await authRequired(request,env);
  if(!session)return json({success:false,error:'登录已失效或无权限'},401);
  if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
  if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN)return json({success:false,error:'Redis not configured'},500);
  try{
    const body=await request.json();
    const sessionRoute=normalizeRoute(session.route);
    const requestedRoute=normalizeRoute(body?.route||'');
    const route=session.role==='admin'?(requestedRoute||sessionRoute):sessionRoute;
    if(!route)return json({success:false,error:'未指定有效线路'},403);
    if(!Array.isArray(body?.orders)||!body.orders.length)return json({success:false,error:'没有可确认的订单'},400);

    const pending=body.orders.filter(x=>x?.needsReview===true||x?.matchType==='review'||String(x?.candidate||'').trim());
    if(pending.length)return json({success:false,code:'REVIEW_REQUIRED',error:`仍有 ${pending.length} 家疑似门店未确认`,review:pending.map(x=>({name:x?.name||'',candidate:x?.candidate||'',matchScore:Number(x?.matchScore)||0}))},409);

    const date=normalizeDate(body.date)||businessDate();
    const base=await loadBase(env,route);
    const canonical=canonicalizeOrders(body.orders,base);
    const orderBatchId=String(body.orderBatchId||'').trim()||createBatchId(route,date);
    const orders=sortOrders(canonical.map((x,i)=>normalizeOrder(x,i,orderBatchId,route,date)),base);
    const todayData={orderBatchId,date,route,vehicle:String(body.vehicle||'').trim(),orders,totalWeight:normalizeWeight(body.totalWeight),count:orders.length,matchedCount:orders.filter(x=>x.matched).length,newStoreCount:orders.filter(x=>x.isNew).length,recognizedCount:Number(body.recognizedCount)||orders.length,rawOrderCount:Number(body.rawOrderCount)||0,source:body.source||'web-confirm',updatedAt:new Date().toISOString()};
    const key=`today_orders:${route}:${date}`;
    await redisSet(env,key,todayData);
    await saveHistory(env,route,date,todayData);
    return json({success:true,data:todayData});
  }catch(e){console.error('confirm api error',e);return json({success:false,error:e?.message||'确认入库失败'},503)}
}

async function loadBase(env,route){const raw=await redisGet(env,`route:${route}:base`);const stores=Array.isArray(raw?.stores)?raw.stores:[];if(!stores.length)throw Error(`未找到${route}独立基准数据库`);return stores.map((s,i)=>({name:String(s?.name||s?.storeName||s?.shopName||s?.['门店名称']||'').trim(),code:String(s?.code||i+1).padStart(2,'0'),nav:String(s?.nav||s?.navigation||s?.url||s?.['导航']||'').trim(),routeOrder:Number(s?.routeOrder||s?.code||i+1)||i+1})).filter(x=>x.name);}
function canonicalizeOrders(input,base){const byName=new Map(base.map(x=>[key(x.name),x]));const byCode=new Map(base.map(x=>[String(x.code),x]));return input.map(x=>{const raw=typeof x==='string'?{name:x}:x||{};const name=String(raw.name||raw.storeName||raw.shopName||raw['门店名称']||'').trim();const hit=byName.get(key(name))||byCode.get(String(raw.code||''));if(hit)return {...raw,name:hit.name,code:hit.code,nav:hit.nav,matched:true,isNew:false,needsReview:false,candidate:'',matchType:'confirmed',matchScore:1};return {...raw,name,matched:false,isNew:true,needsReview:false,candidate:'',matchType:'new'};});}
function sortOrders(orders,base){const rank=new Map(base.map((x,i)=>[key(x.name),Number(x.routeOrder)||i+1]));return orders.map((x,i)=>({...x,__i:i,__r:rank.get(key(x.name))||Number.MAX_SAFE_INTEGER})).sort((a,b)=>a.__r-b.__r||a.__i-b.__i).map(({__i,__r,...x})=>x);}
function normalizeOrder(x,i,batchId,route,date){return{id:String(x.id||`${batchId}-${i+1}`),orderBatchId:batchId,code:String(x.code||`N${String(i+1).padStart(2,'0')}`),name:String(x.name||'').trim(),nav:String(x.nav||'').trim(),weight:Number(x.weight)||0,note:String(x.note||'').trim(),matched:x.matched===true,isNew:x.isNew===true,status:x.status||'待配送',route,date};}
async function saveHistory(env,route,date,today){const key=`history:${route}:${date}`,old=await redisGet(env,key);let list=Array.isArray(old)?old:[];const record={orderBatchId:today.orderBatchId,date,route,vehicle:today.vehicle,count:today.count,weight:today.totalWeight,totalWeight:today.totalWeight,matchedCount:today.matchedCount,newStoreCount:today.newStoreCount,recognizedCount:today.recognizedCount,rawOrderCount:today.rawOrderCount,orders:today.orders,source:today.source,updatedAt:today.updatedAt};const i=list.findIndex(x=>x?.orderBatchId===today.orderBatchId);if(i>=0)list[i]=record;else list.push(record);if(list.length>90)list=list.slice(-90);await redisSet(env,key,list);}
function key(v){return String(v||'').trim().replace(/[\s\u3000（）()【】\[\]{}]/g,'').toLowerCase();}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s;}
function normalizeDate(v){const s=String(v||'').trim().replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:'';}
function businessDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return/吨|\bt\b/i.test(s)?`${n}t`:`${n}kg`;}
function createBatchId(route,date){const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);return `${date}-${route.replace(/[^0-9A-Za-z\u4e00-\u9fa5]/g,'')}-${stamp}`;}
async function redisGet(env,k){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(k)}`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`},cache:'no-store'});if(!r.ok)throw Error('Redis读取失败');const d=await r.json();if(!d.result)return null;try{return JSON.parse(d.result)}catch{return null}}
async function redisSet(env,k,v){const r=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(k)}`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(v)),cache:'no-store'});if(!r.ok)throw Error('Redis保存失败');}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
