/* 天友智配One - OCR结果桥接 */
(function(){
  'use strict';
  const originalFetch=window.fetch;
  function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function weight(v){const s=String(v??'').trim().replace(/,/g,'');const m=s.match(/[0-9]+(?:\.[0-9]+)?/);if(!m)return '';const n=Number(m[0]);return /吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`;}
  function refresh(){try{window.dispatchEvent(new Event('storage'));window.dispatchEvent(new Event('pageshow'));}catch(_){} }
  window.fetch=async function(input,init){
    const response=await originalFetch.apply(this,arguments);
    try{
      const url=typeof input==='string'?input:(input&&input.url)||'';
      if(url.includes('/api/ocr')&&response.ok){
        response.clone().json().then(payload=>{
          const d=payload&&payload.data;if(!d)return;
          if(d.date)localStorage.setItem('today_order_business_date',String(d.date));
          if(d.vehicle)localStorage.setItem('today_vehicle',String(d.vehicle));
          if(d.totalWeight!==undefined&&d.totalWeight!=='')localStorage.setItem('today_total_weight',weight(d.totalWeight));
          if(Array.isArray(d.stores))localStorage.setItem('today_new_store_count',String(d.stores.filter(x=>x&&x.isNew).length));
          if(d.newStoreCount!==undefined)localStorage.setItem('today_new_store_count',String(d.newStoreCount));
          setTimeout(function(){
            if(d.date)localStorage.setItem('today_order_business_date',String(d.date));
            localStorage.setItem('today_order_date',today());
            if(d.vehicle)localStorage.setItem('today_vehicle',String(d.vehicle));
            if(d.totalWeight!==undefined&&d.totalWeight!=='')localStorage.setItem('today_total_weight',weight(d.totalWeight));
            refresh();
          },550);
        }).catch(function(){});
      }
    }catch(_){}
    return response;
  };
})();
