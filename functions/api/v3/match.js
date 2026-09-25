// V3 · 基准库匹配
import { key, clean } from './extract.js';
import { normalizeLearningKey, getRouteLearning } from './learning.js';
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
function similarity(a,b){
 const x=key(a),y=key(b);if(!x||!y)return 0;if(x===y)return 1;
 if(x.includes(y)||y.includes(x))return Math.min(x.length,y.length)/Math.max(x.length,y.length)*.96;
 let same=0;const xs=new Set(x),ys=new Set(y);for(const ch of xs)if(ys.has(ch))same++;
 const charScore=same/Math.max(xs.size,ys.size,1);
 let prefix=0;if(x.slice(0,Math.min(4,x.length))===y.slice(0,Math.min(4,y.length)))prefix=.06;
 let suffix=0;if(x.slice(-Math.min(4,x.length))===y.slice(-Math.min(4,y.length)))suffix=.08;
 return Math.min(1,charScore+prefix+suffix);
}
function identityFeatures(a,b){
 const x=key(a),y=key(b),numbers=v=>[...String(v).matchAll(/[A-Z]{0,4}\\d{3,8}/gi)].map(m=>m[0].toLowerCase());
 const nx=numbers(a),ny=numbers(b),code=nx.length&&ny.length&&nx.some(v=>ny.includes(v))?0.12:0;
 const xEnd=x.slice(-4),yEnd=y.slice(-4),end=xEnd===yEnd&&xEnd.length>=2?.06:0;
 return code+end;
}
function rankCandidate(original,store){
 const name=storeName(store),base=similarity(original,name),feature=identityFeatures(original,name);
 return Math.min(1,base+feature);
}
export function matchStores(candidates,base,learning,context={}){
 const stores=storesOf(base),routeLearning=getRouteLearning(learning,context.route),routeAliases=aliasesOf(routeLearning),aliases=aliasesOf(learning),out=[],pending=[],seen=new Set();
 for(const original of candidates){
  const keyValue=normalizeLearningKey(original);
  const raid=routeAliases.get(keyValue),aid=aliases.get(keyValue),evidence=raid||aid;
  let found=evidence?stores.find(s=>String(s?.storeId||'')===evidence.storeId):null;
  let score=found?Math.min(1,evidence.confidence+Math.min(.09,Math.log10(evidence.count+1)*.045)):0;
  let via=found?(raid?'route-learned-alias':'learned-alias'):'';
  if(!found){
   const ranked=stores.map(s=>{const stat=routeLearning?.stats?.[String(s?.storeId||'')];const history=stat?.seenCount?Math.min(.08,Math.log10(Number(stat.seenCount)+1)*.025):0;return {store:s,score:Math.min(1,rankCandidate(original,s)+history)};}).sort((a,b)=>b.score-a.score);
   const best=ranked[0],second=ranked[1];
   if(best){
    const margin=best.score-(second?.score||0);
    if(best.score>=.72 && (best.score>=.86 || margin>=.08)){found=best.store;score=best.score;via=best.score===1?'canonical':'name';}
   }
  }
  if(!found||score<.72){if(!pending.some(x=>key(x.name)===key(original)))pending.push({name:original,reason:'low-confidence-or-ambiguous'});continue;}
  const id=String(found.storeId||'').trim();if(!id||seen.has(id))continue;seen.add(id);
  out.push({storeId:id,name:storeName(found)||original,originalName:original,routeOrder:Number(found.routeOrder??found.order??999999),corrected:correctionKey(storeName(found))!==correctionKey(original),matchConfidence:Number(score.toFixed(4)),matchVia:via,nav:found.nav||found.navigation||''});
 }
 return {matched:out,pendingStores:pending};
}
