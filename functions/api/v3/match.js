// V3 · 基准库匹配
import { key, clean } from './extract.js';
import { normalizeLearningKey } from './learning.js';
function storeName(s){return clean(s?.name||s?.storeName||s?.title||s?.customerName||s?.['门店名称']);}
function storesOf(base){return Array.isArray(base?.stores)?base.stores:Array.isArray(base?.data?.stores)?base.data.stores:Array.isArray(base)?base:[];}
function aliasesOf(learning){
 const m=new Map();
 for(const [a,r] of Object.entries(learning?.aliases||{})){
  const id=String(r?.storeId||'').trim(),k=normalizeLearningKey(a);
  if(id&&k)m.set(k,{storeId:id,count:Math.max(1,Number(r?.count)||1),confidence:Number(r?.confidence)||.9});
 }
 return m;
}
function correctionKey(v){return clean(v).replace(/Ⅱl|ⅡI/gi,'II').replace(/[Ⅱ]/g,'II').replace(/[\s\u3000，,。.!！:：;；、（）()【】[\]{}“”\"'‘’·_\-/]/g,'').toLowerCase();}
function similarity(a,b){const x=key(a),y=key(b);if(!x||!y)return 0;if(x===y)return 1;if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length)*.96;let h=0;for(const c of new Set(x))if(y.includes(c))h++;return h/Math.max(new Set(x).size,new Set(y).size,1);}
export function matchStores(candidates,base,learning){
 const stores=storesOf(base),aliases=aliasesOf(learning),out=[],pending=[],seen=new Set();
 for(const original of candidates){
  const aid=aliases.get(normalizeLearningKey(original));let found=aid?stores.find(s=>String(s?.storeId||'')===aid.storeId):null;let score=found?Math.min(1,aid.confidence+Math.min(.08,Math.log10(aid.count+1)*.04)):0;let via=found?'learned-alias':'';
  if(!found){for(const s of stores){const n=similarity(original,storeName(s));if(!found||n>score){found=s;score=n;}}via=found&&score>=.72?'name':'';}
  if(!found||score<.72){if(!pending.some(x=>key(x.name)===key(original)))pending.push({name:original});continue;}
  const id=String(found.storeId||'').trim();if(!id||seen.has(id))continue;seen.add(id);
  out.push({storeId:id,name:storeName(found)||original,originalName:original,routeOrder:Number(found.routeOrder??found.order??999999),corrected:correctionKey(storeName(found))!==correctionKey(original),matchConfidence:score,matchVia:via,nav:found.nav||found.navigation||''});
 }
 return {matched:out,pendingStores:pending};
}
