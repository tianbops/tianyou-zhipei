/* 天友智配One - OCR结果桥接
 * 浏览器仅保留显示缓存；OCR批次由服务器生成并保存 orderBatchId。
 */
(function(){
  'use strict';
  const originalFetch=window.fetch;
  function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function weight(v){const s=String(v??'').trim().replace(/,/g,'');const m=s.match(/[0-9]+(?:\.[0-9]+)?/);if(!m)return '';const n=Number(m[0]);return /吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`;}
  function refresh(){try{window.dispatchEvent(new Event('storage'));window.dispatchEvent(new Event('pageshow'));}catch(_){} }
  function authHeaders(){const token=localStorage.getItem('session_token')||localStorage.getItem('auth_token')||localStorage.getItem('token')||'';return token?{Authorization:`Bearer ${token}`}:{}}
  async function persistBatch(d){
    if(!d||!Array.isArray(d.stores)||!d.stores.length)return;
    const response=await originalFetch('/api/ocr-batch',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({route:d.route,date:d.date,vehicle:d.vehicle,totalWeight:d.totalWeight,rawOrderCount:d.rawOrderCount,matchedCount:d.matchedCount,newStoreCount:d.newStoreCount,recognizedCount:d.recognizedCount,stores:d.stores})});
    const payload=await response.json().catch(()=>({}));
    if(!response.ok||!payload.success)throw new Error(payload.error||`OCR批次保存失败 ${response.status}`);
    const id=payload.data?.orderBatchId;if(id)localStorage.setItem('today_order_batch_id',String(id));
    return id;
  }
  window.fetch=async function(input,init){
    const response=await originalFetch.apply(this,arguments);
    try{
      const url=typeof input==='string'?input:(input&&input.url)||'';
      if(url.includes('/api/ocr')&&!url.includes('/api/ocr-batch')&&response.ok){
        response.clone().json().then(async payload=>{
          const d=payload&&payload.data;if(!d)return;
          try{await persistBatch(d);}catch(e){console.error('OCR batch persist failed',e);return;}
          if(d.date)localStorage.setItem('today_order_business_date',String(d.date));
          if(d.vehicle)localStorage.setItem('today_vehicle',String(d.vehicle));
          if(d.totalWeight!==undefined&&d.totalWeight!=='')localStorage.setItem('today_total_weight',weight(d.totalWeight));
          if(Array.isArray(d.stores))localStorage.setItem('today_new_store_count',String(d.stores.filter(x=>x&&x.isNew).length));
          if(d.newStoreCount!==undefined)localStorage.setItem('today_new_store_count',String(d.newStoreCount));
          localStorage.setItem('today_order_date',today());
          refresh();
        }).catch(function(e){console.error('OCR response bridge failed',e);});
      }
    }catch(e){console.error('OCR bridge error',e);}
    return response;
  };
})();
