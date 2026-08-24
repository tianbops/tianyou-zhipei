/* OCR结果桥接：保存服务端提取的日期、车辆、重量、新增门店数 */
(function(){
  const originalFetch=window.fetch;
  window.fetch=async function(input,init){
    const response=await originalFetch.apply(this,arguments);
    try{
      const url=typeof input==='string'?input:(input&&input.url)||'';
      if(url.includes('/api/ocr')&&response.ok){
        const clone=response.clone();
        clone.json().then(payload=>{
          const d=payload&&payload.data;
          if(!d)return;
          setTimeout(function(){
            if(d.date)localStorage.setItem('today_order_date',String(d.date));
            if(d.vehicle)localStorage.setItem('today_vehicle',String(d.vehicle));
            if(d.totalWeight!==undefined&&d.totalWeight!=='')localStorage.setItem('today_total_weight',String(d.totalWeight));
            if(Array.isArray(d.stores))localStorage.setItem('today_new_store_count',String(d.stores.filter(x=>x&&x.isNew).length));
            if(d.newStoreCount!==undefined)localStorage.setItem('today_new_store_count',String(d.newStoreCount));
          },0);
        }).catch(function(){});
      }
    }catch(_){}
    return response;
  };
})();
