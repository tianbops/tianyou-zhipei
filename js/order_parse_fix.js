/* 天友智配One - OCR箭头门店拆分修正 */
(function(){
  'use strict';
  const ARROW=/\s*(?:-\s*>|→|＞|》|➜|➤|⇒|↦)\s*/g;
  function splitName(value){return String(value||'').split(ARROW).map(v=>v.replace(/^\s*[\d０-９]+\s*[、.．)）-]+\s*/,'').replace(/\s+/g,' ').trim()).filter(v=>v.length>=3&&/[\u4e00-\u9fff]/.test(v));}
  function repair(data){
    const stores=[],seen=new Set();
    for(const item of Array.isArray(data?.stores)?data.stores:[]){
      for(const name of splitName(item?.name)){
        const key=name.replace(/\s/g,'').toLowerCase();
        if(!key||seen.has(key))continue;
        seen.add(key);
        stores.push({...item,code:String(stores.length+1).padStart(2,'0'),name,rawName:name,rawNames:[name],matchType:data.baseDatabaseAvailable===false?'raw-order':item?.matchType||'',matched:data.baseDatabaseAvailable===false?false:item?.matched===true,isNew:data.baseDatabaseAvailable===false?false:item?.isNew===true});
      }
    }
    return {...data,stores,storeCount:stores.length,uniqueStoreCount:stores.length,recognizedCount:stores.length,rawOrderCount:Number(data?.rawOrderCount)||stores.length,matchedCount:data?.baseDatabaseAvailable===false?0:Number(data?.matchedCount)||0,newStoreCount:data?.baseDatabaseAvailable===false?0:Number(data?.newStoreCount)||0};
  }
  function write(data){
    const input=document.getElementById('manualOrderInput');if(!input)return;
    const stores=data.stores||[];
    const lines=['【当日订单信息】',`日期：${data.date||''}`,`线路：${data.route||''}`,`车辆：${data.vehicle||'未识别'}`,data.baseDatabaseAvailable===false?'基准库：⚠️ 未建立，以下按本次运单识别顺序显示':`原始门店记录：${Number(data.recognizedCount)||stores.length}条`,`唯一门店：${stores.length}家`,`总重量：${data.totalWeight||'未识别'}`,'','【门店列表】'];
    stores.forEach((item,index)=>lines.push(`${String(index+1).padStart(2,'0')}. ${String(item.name||'').trim()}`));input.value=lines.join('\n');
  }
  const original=window.parseManualInput;if(typeof original!=='function')return;
  window.parseManualInput=async function(){
    const data=await original.apply(this,arguments);if(!data||!Array.isArray(data))return data;
    if(!data.some(item=>/(?:-\s*>|→|＞|》|➜|➤|⇒|↦)/.test(String(item?.name||''))))return data;
    const repaired=repair(data);
    window.onOrderParsed?.(repaired);write(repaired);return repaired.stores;
  };
})();
