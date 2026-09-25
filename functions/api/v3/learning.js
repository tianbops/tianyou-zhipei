// 天友智配One V3 · 自适应门店学习
// 只接收人工确认结果，形成可追溯的 OCR 变体 -> 稳定 storeId 映射。
export function normalizeLearningKey(value){
 return String(value??'').replace(/\s+/g,' ').trim().replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”"'‘’·\-_/]/g,'').toLowerCase();
}
function routeKey(route){return String(route??'').trim().toLowerCase();}
function routeBucket(learning,route){
 const r=routeKey(route); if(!r)return null;
 const routes={...((learning||{}).routes||{})};
 routes[r]={...(routes[r]||{}),aliases:{...((routes[r]||{}).aliases||{})},stats:{...((routes[r]||{}).stats||{})}};
 return {routes,r,bucket:routes[r]};
}
export function learnAlias(learning,rawName,store,context={}){
 const next={...(learning||{}),aliases:{...((learning||{}).aliases||{})},stats:{...((learning||{}).stats||{})}};
 const raw=String(rawName||'').replace(/\s+/g,' ').trim();
 const rawKey=normalizeLearningKey(raw),baseName=String(store?.name||'').trim(),baseKey=normalizeLearningKey(baseName),storeId=String(store?.storeId||'').trim();
 if(!rawKey||!baseKey||!storeId)return next;
 const now=new Date().toISOString(),old=next.aliases[rawKey]||{};
 const route=routeKey(context.route),date=String(context.date||'').trim();
 if(rawKey!==baseKey)next.aliases[rawKey]={baseKey,storeId,baseName,count:Math.max(0,Number(old.count)||0)+1,confidence:Math.min(.995,.9+Math.min(.095,(Math.max(0,Number(old.count)||0))*.015)),source:'confirmed',firstSeen:old.firstSeen||now,lastSeen:now,rawExamples:[...new Set([...(old.rawExamples||[]),raw])].slice(-5)};
 const stat=next.stats[storeId]||{};
 next.stats[storeId]={confirmedCount:Math.max(0,Number(stat.confirmedCount)||0)+1,variantCount:Object.values(next.aliases).filter(x=>String(x?.storeId||'')===storeId).length,lastSeen:now};
 if(route){
  const ctx=routeBucket(next,route); const b=ctx.bucket; const oldRoute=b.aliases[rawKey]||{};
  if(rawKey!==baseKey)b.aliases[rawKey]={baseKey,storeId,baseName,count:Math.max(0,Number(oldRoute.count)||0)+1,confidence:Math.min(.998,.94+Math.min(.055,Math.max(0,Number(oldRoute.count)||0)*.01)),source:'confirmed-route',firstSeen:oldRoute.firstSeen||now,lastSeen:now,rawExamples:[...new Set([...(oldRoute.rawExamples||[]),raw])].slice(-5)};
  const rs=b.stats[storeId]||{};
  const recent=[...(rs.recentDates||[]),date].filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(-8);
  b.stats[storeId]={confirmedCount:Math.max(0,Number(rs.confirmedCount)||0)+1,seenCount:Math.max(0,Number(rs.seenCount)||0)+1,lastSeenDate:date||rs.lastSeenDate||'',recentDates:recent,routeOrderEvidence:[...new Set([...(rs.routeOrderEvidence||[]),Number(store?.routeOrder||0)].filter(v=>v>0))].slice(-8)};
  next.routes=ctx.routes;
 }
 next.schemaVersion=4;next.learningVersion='adaptive-confirmed-v3';next.updatedAt=now;
 return next;
}

export function getRouteLearning(learning,route){ const r=routeKey(route),b=learning?.routes?.[r]; return b||{aliases:{},stats:{}}; }
