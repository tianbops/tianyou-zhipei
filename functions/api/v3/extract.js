// V3 · 门店提取
const SUMMARY=/^(总数量|总重量|总体积|合计|订单编号|运单编号|单号|ZW\w*)/i;
const ID=/^[A-Z]{1,4}\d{3,6}$/i;
export function clean(v){return String(v??'').replace(/[\u200b\ufeff]/g,'').replace(/\s+/g,' ').trim();}
export function key(v){return clean(v).toLowerCase().replace(/[\s·•,，。.!！:：;；、_()（）\[\]{}【】'"“”‘’\-]/g,'');}
function joinWrapped(s){let out='',depth=0;for(const ch of String(s)){if('（(['.includes(ch))depth++;if('）)]'.includes(ch))depth=Math.max(0,depth-1);if(ch==='\n'&&depth>0)continue;out+=ch;}return clean(out);}
function valid(s){s=clean(s);return Boolean(s&&s.length>=3&&!SUMMARY.test(s)&&!/^ZW[A-Z0-9-]+$/i.test(s)&&!ID.test(s)&&/[\u4e00-\u9fff]/.test(s));}
export function extractStores(text){
 let raw=String(text??'').replace(/\r/g,'').replace(/[\t]+/g,' ');
 raw=raw.replace(/总数量[：:]?.*$/gim,'').replace(/总重量[：:]?.*$/gim,'').replace(/总体积[：:]?.*$/gim,'');
 const parts=raw.split(/\s*(?:->|→|➜|➔)\s*/).map(joinWrapped).filter(valid);
 if(parts.length){const out=[];for(const p of parts)for(const x of p.split(/\n+/).map(joinWrapped))if(valid(x))out.push(x);return out;}
 return raw.split(/\n+/).map(joinWrapped).filter(valid);
}
