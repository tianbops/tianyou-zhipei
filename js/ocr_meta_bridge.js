/* 天友智配One - OCR结果桥接
 * OCR返回的运输日期可能不是手机当前日期（例如今天上传8月22日运单），
 * 因此保存两个日期：业务日期用于显示，系统当天日期用于“今日任务”缓存生命周期。
 */
(function(){
  'use strict';
  const originalFetch=window.fetch;
  function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function normalizeWeight(v){
    const s=String(v??'').trim().replace(/,/g,'');
    const m=s.match(/[0-9]+(?:\.[0-9]+)?/); if(!m)return '';
    const n=Number(m[0]); if(!Number.isFinite(n))return '';
    return /吨|\bt\b/i.test(s)?`${(n*1000).toFixed(3).replace(/\.000$/,'')}kg`:`${n}kg`;
  }
  window.fetch=async function(input,init){
    const response=await originalFetch.apply(this,arguments);
    try{
      const url=typeof input==='string'?input:(input&&input.url)||'';
      if(url.includes('/api/ocr')&&response.ok){
        const clone=response.clone();
        clone.json().then(payload=>{
          const d=payload&&payload.data; if(!d)return;
          if(d.date)localStorage.setItem('today_order_business_date',String(d.date));
          if(d.vehicle)localStorage.setItem('today_vehicle',String(d.vehicle));
          if(d.totalWeight!==undefined&&d.totalWeight!=='')localStorage.setItem('today_total_weight',normalizeWeight(d.totalWeight));
          if(Array.isArray(d.stores))localStorage.setItem('today_new_store_count',String(d.stores.filter(x=>x&&x.isNew).length));
          if(d.newStoreCount!==undefined)localStorage.setItem('today_new_store_count',String(d.newStoreCount));
          /* home.js随后保存订单时使用系统日期。这里保留业务日期另存，避免详情页因日期不同而把刚解析的运单判定为空。 */
          setTimeout(function(){
            if(d.date)localStorage.setItem('today_order_business_date',String(d.date));
            if(d.totalWeight!==undefined&&d.totalWeight!=='')localStorage.setItem('today_total_weight',normalizeWeight(d.totalWeight));
            if(d.vehicle)localStorage.setItem('today_vehicle',String(d.vehicle));
            localStorage.setItem('today_order_date',today());
          },500);
        }).catch(function(){});
      }
    }catch(_){}
    return response;
  };
})();
