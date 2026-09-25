// 天友智配One V3 · 确认后的门店学习
import { authRequired } from './_auth.js';
import { isRouteMaintainer, getBase, getLearning, setLearning, normalizeRoute } from './v3/data.js';
const MAX_ALIASES=1000,MAX_BATCH=100;
export async function onRequest({request,env}){
 if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
 const session=await authRequired(request,env,{allowAnyRoute:true});
 if(!session?.id)return json({success:false,error:'登录已失效'},401);
 try{
  const body=await request.json().catch(()=>({}));
  const route=normalizeRoute(body.route);
  if(!route)return json({success:false,error:'缺少调度线路'},400);
  if(!route||!isRouteMaintainer(session,route))return json({success:false,error:'只有绑定该线路的用户可以维护门店学习数据'},403);
  const input=Array.isArray(body.items)?body.items:[body];
  if(input.length>MAX_BATCH)return json({success:false,error:`单次最多学习 ${MAX_BATCH} 家门店`},400);
  const base=await getBase(env,route);
  if(!base)return json({success:false,error:'未找到当前线路基准库'},404);
  const items=input.map(normalizeInput).filter(x=>x.rawName&&(x.storeId||x.baseName));
  if(!items.length)return json({success:false,error:'缺少待学习门店信息'},400);
  const learning=await getLearning(env,route);
  const aliases=learning.aliases&&typeof learning.aliases==='object'?learning.aliases:{};
  const now=new Date().toISOString(),learned=[];
  for(const item of items){
   const target=resolveTarget(base.stores,item);
   if(!target)return json({success:false,error:`确认的基准门店不属于当前线路：${item.baseName||item.storeId}`},400);
   const aliasKey=matchKey(item.rawName),baseKey=matchKey(target.name);
   if(!aliasKey||!baseKey||aliasKey===baseKey)continue;
   const prev=aliases[aliasKey]||{};
   const examples=Array.isArray(prev.rawExamples)?prev.rawExamples.filter(Boolean):[];
   if(!examples.includes(item.rawName))examples.push(item.rawName);
   aliases[aliasKey]={baseKey,storeId:String(target.storeId||''),baseName:target.name,count:Math.max(1,Number(prev.count)||0)+1,firstSeenAt:prev.firstSeenAt||now,updatedAt:now,rawExamples:examples.slice(-3)};
   learned.push({rawName:item.rawName,baseName:target.name,count:aliases[aliasKey].count});
  }
  prune(aliases,MAX_ALIASES);
  await setLearning(env,route,{...learning,aliases,updatedBy:session.id,updatedAt:now});
  return json({success:true,data:{route,learned:true,learnedCount:learned.length,aliasCount:Object.keys(aliases).length,items:learned}});
 }catch(e){console.error('V3 learning error',e);return json({success:false,error:e?.message||'学习记录保存失败'},503);}
}
function normalizeInput(v){v=v&&typeof v==='object'?v:{};return{rawName:clean(v.rawName),baseName:clean(v.baseName),storeId:clean(v.storeId)};}
function resolveTarget(base,item){if(item.storeId)return (base||[]).find(s=>String(s?.storeId||'')===item.storeId)||null;return (base||[]).find(s=>matchKey(s?.name)===matchKey(item.baseName))||null;}
function clean(v){return String(v||'').replace(/\s+/g,' ').trim();}
function matchKey(v){return clean(v).replace(/[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g,x=>({Ⅱ:'II',Ⅲ:'III',Ⅳ:'IV',Ⅴ:'V',Ⅵ:'VI',Ⅶ:'VII',Ⅷ:'VIII',Ⅸ:'IX',Ⅹ:'X'}[x]||x)).replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g,'').toLowerCase();}
function prune(obj,n){const entries=Object.entries(obj);if(entries.length<=n)return;entries.sort((a,b)=>String(a[1]?.updatedAt||'').localeCompare(String(b[1]?.updatedAt||'')));for(const [k] of entries.slice(0,entries.length-n))delete obj[k];}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
