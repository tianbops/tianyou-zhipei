// 天友智配One - 运单文字解析
// OCR与解析彻底分离：用户确认/修改OCR文字后，点击“开始解析”才进入本接口。
import { authRequired } from './_auth.js';

export async function onRequest({request,env}){
  if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
  const session=await authRequired(request,env);
  if(!session)return json({success:false,error:'登录已失效或无权限'},401);
  try{
    const body=await request.json(),text=String(body?.text||'').trim();
    if(!text)return json({success:false,error:'请输入或先识别运单文字'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);
    const sessionRoute=normalizeRoute(session.route),requestedRoute=normalizeRoute(body?.route||''),route=session.role==='admin'?(requestedRoute||sessionRoute):sessionRoute;
    if(!route)return json({success:false,error:'用户未绑定线路'},403);
    const base=await getBaseStores(env,route),parsed=await parseOrderText(env.AI,text),result=normalizeAndSort(parsed.stores,base);
    if(!result.stores.length)return json({success:false,error:'未识别到有效门店，请检查OCR文字后再解析'},422);
    const meta={route,date:normalizeDate(parsed.date)||normalizeDate(extractDate(text)),vehicle:normalizeVehicle(parsed.vehicle)||extractVehicle(text),totalWeight:normalizeWeight(parsed.totalWeight)||normalizeWeight(extractWeight(text)),rawOrderCount:Number(parsed.rawOrderCount)||extractRawOrderCount(text)};
    return json({success:true,data:{...meta,stores:result.stores,storeCount:result.stores.length,matchedCount:result.matchedCount,newStoreCount:result.newStoreCount,reviewCount:result.reviewCount,recognizedCount:result.recognizedCount,warning:result.reviewCount?`发现 ${result.reviewCount} 家疑似门店需要确认`:result.newStoreCount?`发现 ${result.newStoreCount} 家新增门店，请核对`:''}});
  }catch(e){console.error('parse api error',e);return json({success:false,error:e?.message||'运单文字解析失败'},500)}
}

async function parseOrderText(AI,text){
  const prompt=`你是“天友智配One”运单文字解析器。用户已经检查过OCR原文，现在只从这段文字中提取真实配送门店，不要进行基准库匹配。\n\n严格规则：\n1. “承运订单”之后的客户配送链是最重要的信息。\n2. ->、→、＞、》、➜、➤、⇒都是门店之间的分隔符。\n3. 如果公司名称因OCR换行被拆成多行，要合并成一家门店；换行不是门店边界。\n4. 必须从第一个客户读取到最后一个客户，不能只取前几家。\n5. “总数量207”绝对不是门店数量。rawOrderCount只能记录207，不得把207变成门店。\n6. 忽略额定载重、额定体积、主司机、送货员、订单编号、金额等非门店信息。\n7. 保留公司全称、区域、括号内容以及JM/Q等有意义的门店标识。\n8. 不要猜测不存在的门店。\n9. 返回的stores只包含门店名称字符串，不包含序号。\n\n只返回JSON，不要Markdown：\n{"date":"2026-08-22","vehicle":"渝DK7692","totalWeight":"1.806213t","rawOrderCount":207,"stores":["门店A","门店B"]}\n\nOCR文字：\n${text}`;
  try{
    const r=await AI.run('@cf/google/gemma-4-26b-a4b-it',{messages:[{role:'user',content:prompt}],max_completion_tokens:4096,temperature:0,chat_template_kwargs:{thinking:false}});
    return parseAI(r,text);
  }catch(e){return fallbackParse(text)}
}
function parseAI(r,text){const s=extractAIText(r).trim(),a=s.indexOf('{'),z=s.lastIndexOf('}');for(const x of [s,a>=0&&z>a?s.slice(a,z+1):'']){if(!x)continue;try{const d=JSON.parse(x);if(d&&Array.isArray(d.stores))return{date:d.date||'',vehicle:d.vehicle||'',totalWeight:d.totalWeight||'',rawOrderCount:d.rawOrderCount||0,stores:expandStoreList(d.stores)}}catch(_){} }return fallbackParse(text)}
function extractAIText(r){if(typeof r==='string')return r;if(!r||typeof r!=='object')return '';return String(r.response??r.text??r.result?.response??r.result?.text??'')}
function fallbackParse(text){const normalized=String(text||'').replace(/→|＞|》|➜|➤|⇒/g,'->');const hasArrow=/->/.test(normalized);const chunks=hasArrow?normalized.split(/\s*(?:->|-->)\s*/):normalized.split(/\r?\n/);const stores=[];for(let i=0;i<chunks.length;i++){let chunk=cleanStoreName(chunks[i]);if(i===0&&hasArrow){const p=chunk.lastIndexOf('承运订单');if(p>=0)chunk=cleanStoreName(chunk.slice(p+'承运订单'.length))}if(i===chunks.length-1)chunk=chunk.replace(/总重量[\s\S]*$/,'').trim();if(isLikelyStore(chunk))stores.push(chunk)}return{date:extractDate(text),vehicle:extractVehicle(text),totalWeight:extractWeight(text),rawOrderCount:extractRawOrderCount(text),stores:unique(stores)}}
function expandStoreList(items){const out=[];for(const item of items||[]){const v=typeof item==='string'?item:item?.name||item?.storeName||item?.customerName||'';String(v).replace(/→|＞|》|➜|➤|⇒/g,'->').split(/\s*(?:->|-->)\s*/).forEach(x=>{const n=cleanStoreName(x);if(isLikelyStore(n))out.push(n)})}return unique(out)}
async function getBaseStores(env,route){const key=`route:${normalizeRoute(route)}:base`,url=env.UPSTASH_REDIS_REST_URL,token=env.UPSTASH_REDIS_REST_TOKEN;if(!url||!token)throw new Error('服务器基准数据库不可用');const r=await fetch(`${url.replace(/\/$/,'')}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${token}`},cache:'no-store'});if(!r.ok)throw new Error('线路基准数据库读取失败');const d=await r.json();let p=d?.result;try{p=typeof p==='string'?JSON.parse(p):p}catch(_){p=null}if(!Array.isArray(p?.stores)||!p.stores.length)throw new Error(`未找到${normalizeRoute(route)}独立基准数据库`);return p.stores}
function normalizeAndSort(recognized,baseStores){const src=unique((recognized||[]).map(cleanStoreName).filter(Boolean)),base=(baseStores||[]).map(normalizeBase).filter(Boolean),matched=[],news=[],review=[],used=new Set();src.forEach(raw=>{const rk=matchKey(raw);let exact=null,best=null,bestScore=0;for(const b of base){if(used.has(b.index))continue;const bk=matchKey(b.name);if(rk===bk){exact=b;break}const score=similarity(rk,bk);if(score>bestScore){bestScore=score;best=b}}if(exact){used.add(exact.index);matched.push(toMatched(exact,false,1));return}if(best&&bestScore>=0.88){used.add(best.index);matched.push(toMatched(best,true,bestScore));return}if(best&&bestScore>=0.72&&Math.min(rk.length,best?matchKey(best.name).length:0)>=6){review.push({code:'',name:raw,nav:'',isNew:false,matched:false,needsReview:true,candidate:best.name,matchScore:Number(bestScore.toFixed(3))});return}if(isLikelyStore(raw))news.push({code:'',name:raw,nav:'',isNew:true,matched:false})});matched.sort((a,b)=>a._i-b._i);news.forEach((x,i)=>x.code=`N${String(i+1).padStart(2,'0')}`);review.forEach((x,i)=>x.code=`R${String(i+1).padStart(2,'0')}`);return{stores:matched.concat(review,news).map(x=>{const y={...x};delete y._i;return y}),recognizedCount:src.length,matchedCount:matched.length,newStoreCount:news.length,reviewCount:review.length}}
function toMatched(hit,assisted,score){return{code:hit.code,name:hit.name,nav:hit.nav||'',isNew:false,matched:true,matchType:assisted?'similarity':'exact',matchScore:score,_i:hit.index}}
function normalizeBase(s,i){if(typeof s==='string')return{name:cleanStoreName(s),code:String(i+1).padStart(2,'0'),nav:'',index:i};if(!s)return null;const name=cleanStoreName(s.name||s.storeName||s.title||s.customerName||'');return name?{name,code:String(s.code||i+1).padStart(2,'0'),nav:s.nav||s.navigation||s.url||'',index:i}:null}
function matchKey(s){return cleanStoreName(s).replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”"'‘’·\-_/]/g,'').toLowerCase()}
function similarity(a,b){if(!a||!b)return 0;if(a===b)return 1;if(a.includes(b)||b.includes(a))return Math.min(a.length,b.length)/Math.max(a.length,b.length);const m=a.length,n=b.length;if(!m||!n)return 0;const prev=Array.from({length:n+1},(_,i)=>i);for(let i=1;i<=m;i++){let left=prev[0];prev[0]=i;for(let j=1;j<=n;j++){const up=prev[j],cost=a[i-1]===b[j-1]?0:1;prev[j]=Math.min(prev[j]+1,prev[j-1]+1,left+cost);left=up}}return 1-prev[n]/Math.max(m,n)}
function cleanStoreName(v){return String(v||'').replace(/^[\s\d]+[、.．)）-]+/,'').replace(/\s+/g,' ').replace(/^承运订单[：:\s]*/,'').trim()}
function unique(a){const s=new Set();return a.filter(x=>{const k=matchKey(x);if(!k||s.has(k))return false;s.add(k);return true})}
function isLikelyStore(v){if(!v||v.length<3||v.length>160)return false;if(/总重量|总数量|总体积|订单编号|运单编号|车牌|车辆|运输日期|日期|司机|送货员|主司机|承运订单|额定装载|额定载重|额定体积|总计|合计|单价|金额/.test(v))return false;return /店|公司|经销商|加盟|中心|超市|便利|生鲜|食品|贸易|商行|门市|乳业|大厦|药房|餐饮|酒店|委员会|管理中心|服务中心/.test(v)}
function extractDate(s){const m=String(s||'').match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);return m?normalizeDate(m[1]):''}
function extractVehicle(s){const m=String(s||'').match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);return m?normalizeVehicle(m[1]):''}
function extractWeight(s){const m=String(s||'').match(/总重量\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);return m?`${m[1]}${m[2]||'kg'}`:''}
function extractRawOrderCount(s){const m=String(s||'').match(/总数量\s*[:：]?\s*(\d+)/);return m?Number(m[1]):0}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return/吨|\bt\b/i.test(s)?`${n}t`:`${n}kg`}
function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}
function normalizeDate(v){const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return m?`${String(parseInt(m[1]||m[2],10)).padStart(2,'0')}号线`:s}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
