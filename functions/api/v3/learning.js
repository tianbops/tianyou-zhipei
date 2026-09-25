// 天友智配One V3 · 自适应门店学习
// 只接收人工确认结果，形成可追溯的 OCR 变体 -> 稳定 storeId 映射。
export function normalizeLearningKey(value){
 return String(value??'').replace(/\s+/g,' ').trim().replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”"'‘’·\-_/]/g,'').toLowerCase();
}
export function learnAlias(learning,rawName,store){
 const next={...(learning||{}),aliases:{...((learning||{}).aliases||{})},stats:{...((learning||{}).stats||{})}};
 const raw=String(rawName||'').replace(/\s+/g,' ').trim();
 const rawKey=normalizeLearningKey(raw),baseName=String(store?.name||'').trim(),baseKey=normalizeLearningKey(baseName),storeId=String(store?.storeId||'').trim();
 if(!rawKey||!baseKey||!storeId||rawKey===baseKey)return next;
 const now=new Date().toISOString(),old=next.aliases[rawKey]||{};
 next.aliases[rawKey]={baseKey,storeId,baseName,count:Math.max(0,Number(old.count)||0)+1,confidence:Math.min(.995,.9+Math.min(.095,(Math.max(0,Number(old.count)||0))*.015)),source:'confirmed',firstSeen:old.firstSeen||now,lastSeen:now,rawExamples:[...new Set([...(old.rawExamples||[]),raw])].slice(-5)};
 const stat=next.stats[storeId]||{};
 next.stats[storeId]={confirmedCount:Math.max(0,Number(stat.confirmedCount)||0)+1,variantCount:Object.values(next.aliases).filter(x=>String(x?.storeId||'')===storeId).length,lastSeen:now};
 next.schemaVersion=3;next.learningVersion='adaptive-confirmed-v2';next.updatedAt=now;
 return next;
}
