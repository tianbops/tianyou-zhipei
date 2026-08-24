// 天友智配One - 运单截图 OCR
// 目标：日期、车牌、总重量、实际门店；门店以箭头为边界；再按基准库排序；未知门店置底。
export async function onRequest({request,env}){
  if(request.method!=='POST')return json({success:false,error:'Method not allowed'},405);
  try{
    const body=await request.json(),image=body?.image,route=String(body?.route||'').trim();
    if(!image||!route)return json({success:false,error:'缺少运单图片或线路'},400);
    if(!env.AI||typeof env.AI.run!=='function')return json({success:false,error:'Cloudflare Workers AI 未绑定'},500);
    const parsed=await runVisionOCR(env.AI,image),base=await getBaseStores(env,route,request),result=normalizeAndSort(parsed.stores,base,parsed.rawText);
    if(!result.stores.length)return json({success:false,error:'图片中未识别到有效门店，请重新上传清晰截图'},422);
    return json({success:true,data:{route,date:normalizeDate(parsed.date),vehicle:normalizeVehicle(parsed.vehicle),totalWeight:normalizeWeight(parsed.totalWeight),rawOrderCount:Number(parsed.rawOrderCount)||0,stores:result.stores,storeCount:result.stores.length,matchedCount:result.matchedCount,newStoreCount:result.newStoreCount,recognizedCount:result.recognizedCount,warning:result.newStoreCount?`发现 ${result.newStoreCount} 家新增门店，请核对`:''}});
  }catch(e){console.error('OCR error',e);return json({success:false,error:e?.message||'运单图片处理失败'},500)}
}
async function runVisionOCR(AI,image){
  const bytes=decodeImageBase64(image);if(!bytes.length)throw new Error('图片数据无效或无法解码');
  const prompt=`你是“天友智配One”运单截图OCR。请完整读取这张手机截图，不能猜测、不能遗漏。重点读取“承运订单”下面的整条配送路线。

规则：
1. 提取运输日期、车牌号、总重量、总数量。
2. “总数量207”是商品/订单数量，绝对不是门店数量。
3. 承运订单路线由客户名称和箭头组成：A -> B -> C。每个箭头代表一个门店边界。
4. 手机截图自动换行不能作为门店边界；一家很长的公司名换成两三行仍然只算一家。
5. 箭头可能是 ->、→、＞、》、➜、➤、⇒，全部视为分隔符。
6. 必须从第一个客户一直读到最后一个客户，不能只输出前几家。
7. 保留区域、JM/Q编号、公司全称和括号内容。
8. 忽略额定载重18吨、额定体积40m³、主司机、送货员以及底部ZW订单编号。
9. 如果“承运订单”四个字没有被清楚识别，也不要失败；请继续从整张图片中寻找所有客户/门店名称。
10. 不要把门店数量猜成总数量；门店数量由实际客户名称决定。

只返回JSON，不要Markdown，不要解释：
{"date":"2026-08-22","vehicle":"渝DK7692","rawOrderCount":207,"totalWeight":"1.806213t","routeText":"A -> B -> C","stores":["A","B","C"]}`;
  const dataUrl=String(image),messages=[{role:'user',content:[{type:'text',text:prompt},{type:'image_url',image_url:{url:dataUrl}}]}];
  try{
    const r=await AI.run('@cf/google/gemma-4-26b-a4b-it',{messages,max_completion_tokens:4096,temperature:0,chat_template_kwargs:{thinking:false}});
    return parseAIResponse(r);
  }catch(first){
    const r=await AI.run('@cf/llava-hf/llava-1.5-7b-hf',{prompt,image:Array.from(bytes),max_tokens:4096,temperature:0.01});
    return parseAIResponse(r);
  }
}
function extractAIText(r){if(typeof r==='string')return r;if(!r||typeof r!=='object')return '';return String(r.response??r.text??r.description??r.result?.response??r.result?.text??r.result?.description??'')}
function parseAIResponse(r){const s=extractAIText(r).trim(),c=[];const f=s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);if(f)c.push(f[1]);c.push(s);const a=s.indexOf('{'),z=s.lastIndexOf('}');if(a>=0&&z>a)c.push(s.slice(a,z+1));for(const x of c){try{const d=JSON.parse(x);if(d&&Array.isArray(d.stores)){let stores=expandStoreList(d.stores);if(d.routeText&&countArrows(d.routeText)>0){const rs=splitStoreChain(d.routeText).map(cleanStoreName).filter(isLikelyStore);if(rs.length>=stores.length)stores=unique(rs)}return{stores,date:d.date||'',vehicle:d.vehicle||'',totalWeight:d.totalWeight||'',rawOrderCount:d.rawOrderCount||0,rawText:s}}}catch(_){}}const fb=fallback(s);fb.rawText=s;return fb}
function countArrows(v){return String(v||'').match(/->|→|＞|》|➜|➤|⇒/g)?.length||0}
function expandStoreList(items){const out=[];for(const item of items||[]){const v=typeof item==='string'?item:item?.name||item?.storeName||item?.customerName||'';splitStoreChain(v).forEach(x=>{const n=cleanStoreName(x);if(n)out.push(n)})}return unique(out)}
function splitStoreChain(v){return String(v||'').replace(/→|＞|》|➜|➤|⇒/g,'->').split(/\s*(?:->|-->)\s*/).map(x=>x.trim()).filter(Boolean)}
function fallback(s){const chains=s.match(/[^\n{}]{2,}(?:\s*(?:->|→|〉|》|➜|➤|⇒)\s*[^\n{}]{2,})+/g)||[];const stores=[];chains.forEach(c=>splitStoreChain(c).forEach(p=>{const n=cleanStoreName(p);if(isLikelyStore(n))stores.push(n)}));const w=s.match(/总重量\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i),v=s.match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i),d=s.match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/),c=s.match(/总数量\s*[:：]?\s*(\d+)/);return{stores:unique(stores),date:d?d[1]:'',vehicle:v?v[1]:'',totalWeight:w?`${w[1]}${w[2]||'kg'}`:'',rawOrderCount:c?Number(c[1]):0}}
async function getBaseStores(env,route,request){
  const key=`route:${route}`,url=env.UPSTASH_REDIS_REST_URL,token=env.UPSTASH_REDIS_REST_TOKEN;
  // 第一优先级：Upstash 中该线路的实时基准数据。
  if(url&&token){
    try{
      const r=await fetch(`${url.replace(/\/$/,'')}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${token}`}});
      if(r.ok){const d=await r.json();let p=d?.result;try{p=typeof p==='string'?JSON.parse(p):p}catch(_){p=null}if(Array.isArray(p?.stores)&&p.stores.length)return p.stores;}
    }catch(_){/* 继续使用仓库 Golden Source */}
  }
  // 第二优先级：仓库中的 Golden Source，避免数据库临时异常导致所有门店被误判为新增。
  try{
    const origin=new URL(request.url).origin;
    const r=await fetch(`${origin}/data/base_data.json`,{cache:'no-store'});
    if(r.ok){const d=await r.json();if(normalizeRoute(d?.line)===normalizeRoute(route)&&Array.isArray(d?.stores)&&d.stores.length)return d.stores;}
  }catch(_){/* 最后允许返回空数组 */}
  return [];
}
function normalizeRoute(v){const s=String(v||'').trim(),m=s.match(/^(\d+)号线$/);return m?`${String(parseInt(m[1],10)).padStart(2,'0')}号线`:s}
function normalizeBase(s,i){if(typeof s==='string')return{name:cleanStoreName(s),code:String(i+1).padStart(2,'0'),nav:'',index:i};if(!s)return null;const name=cleanStoreName(s.name||s.storeName||s.title||s.customerName||'');return name?{name,code:String(s.code||i+1).padStart(2,'0'),nav:s.nav||s.navigation||s.url||'',index:i}:null}
function matchKey(s){return cleanStoreName(s).replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”"'‘’·-]/g,'').toLowerCase()}
function normalizeAndSort(recognized,baseStores,rawText=''){const src=unique((recognized||[]).map(cleanStoreName).filter(Boolean)),base=(baseStores||[]).map(normalizeBase).filter(Boolean);let candidate=src;if(base.length&&candidate.length<2&&rawText){const recovered=[];for(const b of base){const n=matchKey(b.name);if(n.length>=6&&matchKey(rawText).includes(n))recovered.push(b.name)}candidate=unique(candidate.concat(recovered))}
  if(!base.length)return{stores:candidate.map((name,i)=>({code:String(i+1).padStart(2,'0'),name,nav:'',isNew:true,matched:false})),recognizedCount:candidate.length,matchedCount:0,newStoreCount:candidate.length};
  const matched=[],news=[],used=new Set();candidate.forEach(raw=>{const rk=matchKey(raw);let hit=null;for(const b of base){if(used.has(b.index))continue;const bk=matchKey(b.name);if(rk===bk){hit=b;break}if(rk.length>10&&bk.length>10&&(rk.includes(bk)||bk.includes(rk)))hit=hit||b}if(hit){used.add(hit.index);matched.push({code:hit.code,name:hit.name,nav:hit.nav||'',isNew:false,matched:true,_i:hit.index})}else if(isLikelyStore(raw))news.push({code:'',name:raw,nav:'',isNew:true,matched:false})});matched.sort((a,b)=>a._i-b._i);news.forEach((x,i)=>x.code=`N${String(i+1).padStart(2,'0')}`);return{stores:matched.concat(news).map(x=>{const y={...x};delete y._i;return y}),recognizedCount:candidate.length,matchedCount:matched.length,newStoreCount:news.length}}
function cleanStoreName(v){return String(v||'').replace(/^[\s\d]+[、.．)）-]+/,'').replace(/\s+/g,' ').trim()}
function unique(a){const s=new Set();return a.filter(x=>{const k=matchKey(x);if(!k||s.has(k))return false;s.add(k);return true})}
function isLikelyStore(v){if(!v||v.length<3||v.length>160)return false;if(/总重量|总数量|总体积|订单编号|运单编号|车牌|车辆|运输日期|日期|司机|送货员|主司机|承运订单|额定装载|额定载重|额定体积|总计|合计|单价|金额/.test(v))return false;return /店|公司|经销商|加盟|中心|超市|便利|生鲜|食品|贸易|商行|门市|乳业|大厦|药房|餐饮|酒店|委员会|管理中心|服务中心/.test(v)}
function decodeImageBase64(input){let v=String(input||'').trim(),comma=v.indexOf(',');if(v.startsWith('data:')&&comma>=0)v=v.slice(comma+1);v=v.replace(/\s/g,'');const b=atob(v),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a}
function normalizeWeight(v){if(v===null||v===undefined||v==='')return '';const s=String(v).trim(),m=s.match(/[\d]+(?:\.\d+)?/);if(!m)return '';const n=Number(m[0]);return/吨|\bt\b/i.test(s)?`${n}t`:`${n}kg`}
function normalizeVehicle(v){return String(v||'').replace(/[\s>]+$/,'').trim()}
function normalizeDate(v){const s=String(v||'').replace(/[年月]/g,'-').replace(/日/g,'').replace(/[/.]/g,'-'),m=s.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);return m?`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`:s}
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json;charset=UTF-8','Cache-Control':'no-store'}})}
