/* 天友智配One - 今日运单详情 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  function readJSON(key, fallback = null) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } }
  function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function cleanName(v) { return String(v || '').replace(/[\u3000]/g,' ').replace(/^\s*[\d０-９]+[、.．)）\s-]*/u,'').replace(/\s+/g,' ').trim(); }
  function key(v) { return cleanName(v).replace(/[\s，,。；;：:（）()【】\[\]]/g,'').toLowerCase(); }
  function normalizeStore(x,i) { if(typeof x==='string') return {code:String(i+1).padStart(2,'0'),name:cleanName(x),nav:'',weight:0,isNew:false}; x=x||{}; return {code:String(x.code||x.index||i+1).padStart(2,'0'),name:cleanName(x.name||x.storeName||x.shopName||x['门店名称']),nav:String(x.nav||x.navigation||x.url||x.amap||x['导航']||'').trim(),weight:parseWeight(x.weight??x['重量']??0),isNew:Boolean(x.isNew||x.newStore||x.is_new)}; }
  function normalizeOrders(raw) { if(!Array.isArray(raw)) return []; const seen=new Set(); return raw.map(normalizeStore).filter(x=>{if(!x.name)return false;const k=key(x.name);if(seen.has(k))return false;seen.add(k);return true;}); }
  function getBaseStores(route) { const local=readJSON('base_data',[]); if(Array.isArray(local)&&local.length)return local; const cached=readJSON(`route_cache_${route}`,null); return Array.isArray(cached?.stores)?cached.stores:[]; }
  function normalizeBaseName(x){return cleanName(x?.name||x?.storeName||x?.shopName||'');}
  function sortByBaseRoute(raw,baseStores) {
    const source=normalizeOrders(raw), base=Array.isArray(baseStores)?baseStores:[];
    if(!base.length)return source.map((x,i)=>({...x,displayCode:String(i+1).padStart(2,'0')}));
    const matched=[], news=[], used=new Set();
    base.forEach((b,bi)=>{
      const bk=key(normalizeBaseName(b));
      const bc=String(b?.code||bi+1).padStart(2,'0');
      const idx=source.findIndex((o,i)=>!used.has(i) && ((bk&&key(o.name)===bk) || (!o.name&&String(o.code||'')===bc)));
      if(idx<0)return;
      used.add(idx); const o=source[idx];
      matched.push({...o,code:bc,displayCode:bc,name:normalizeBaseName(b)||o.name,nav:String(b?.nav||b?.navigation||b?.url||b?.amap||o.nav||'').trim(),isNew:false});
    });
    source.forEach((o,i)=>{if(used.has(i))return; const exists=base.some(b=>key(normalizeBaseName(b))===key(o.name)); if(!exists)news.push({...o,isNew:true});});
    news.forEach((x,i)=>x.displayCode=String(matched.length+i+1).padStart(2,'0'));
    return matched.concat(news);
  }
  function parseWeight(v){const m=String(v??'').replace(/,/g,'').match(/\d+(?:\.\d+)?/);if(!m)return 0;const n=Number(m[0]);return /吨|\bt\b/i.test(String(v))?n*1000:n;}
  function getLocalOrders(){const d=localStorage.getItem('today_order_date');if(d&&d!==todayKey())return [];return readJSON('today_orders',[]);}
  function renderSummary(orders,totalWeightValue){const total=orders.length,newCount=orders.filter(x=>x.isNew).length;const count=$('storeCount');if(count){count.textContent=newCount?`⚠️ 新${newCount}家、总${total}家`:`${total}家`;count.classList.toggle('new-warning',newCount>0);}const calculated=orders.reduce((s,x)=>s+parseWeight(x.weight),0);const w=totalWeightValue!==''&&totalWeightValue!=null?parseWeight(totalWeightValue):calculated;if($('totalWeight'))$('totalWeight').textContent=`${Number(w.toFixed(2))} kg`;}
  function renderRoute(orders,totalWeightValue=''){const box=$('routeList');if(!box)return;box.innerHTML='';if(!orders.length){box.innerHTML='<div class="empty-tip"><span class="icon">📭</span>今日暂无配送数据</div>';if($('storeCount'))$('storeCount').textContent='0家';if($('totalWeight'))$('totalWeight').textContent='0 kg';return;}orders.forEach(store=>{const row=document.createElement('div');row.className='store-item';const idx=document.createElement('span');idx.className='store-index';idx.textContent=`${store.displayCode||store.code}、`;const name=document.createElement('span');name.className='store-name';if(store.isNew){name.textContent='⚠️ 新增 '+store.name;name.title='基准数据库未建立，新增门店';}else name.textContent=store.name;const nav=document.createElement('button');nav.className='nav-btn';nav.type='button';nav.textContent='导航';nav.onclick=()=>{if(store.nav)window.location.href=store.nav;else alert('该门店暂无导航地址');};row.append(idx,name,nav);box.appendChild(row);});renderSummary(orders,totalWeightValue);}
  async function loadOrders(route){const base=getBaseStores(route),local=getLocalOrders();if(local.length)return {orders:sortByBaseRoute(local,base),totalWeight:localStorage.getItem('today_total_weight')||''};try{const r=await fetch(`/api/history?date=${todayKey()}&route=${encodeURIComponent(route)}`,{cache:'no-store'});if(!r.ok)return {orders:[],totalWeight:''};const d=await r.json();let rec=Array.isArray(d)?(d.find(x=>x?.date===todayKey()&&(!x.route||x.route===route))||d[0]):d;const raw=rec?.orders||rec?.today_orders||rec?.data?.orders||[];const orders=sortByBaseRoute(raw,base),weight=rec?.totalWeight??rec?.weight??rec?.data?.totalWeight??'';if(orders.length){localStorage.setItem('today_orders',JSON.stringify(orders));localStorage.setItem('today_order_date',todayKey());if(weight!=='')localStorage.setItem('today_total_weight',String(weight));}return {orders,totalWeight:weight};}catch(e){console.warn('今日运单 API 读取失败:',e);return {orders:[],totalWeight:''};}}
  function initHeader(route,vehicle){if($('routeName'))$('routeName').textContent=route||'未选择线路';if($('menuRoute'))$('menuRoute').textContent=route||'未选择线路';if($('todayDate'))$('todayDate').textContent=localStorage.getItem('today_order_date')||todayKey();if($('vehicleText'))$('vehicleText').textContent=vehicle||'渝DK7692';if($('newVehicle'))$('newVehicle').value=vehicle||'渝DK7692';}
  window.toggleMenu=()=>{const m=$('menuPanel');if(m)m.style.display=m.style.display==='block'?'none':'block';};
  window.openVehicle=()=>{if($('vehicleDialog'))$('vehicleDialog').style.display='flex';if($('menuPanel'))$('menuPanel').style.display='none';};
  window.closeVehicle=()=>{if($('vehicleDialog'))$('vehicleDialog').style.display='none';};
  window.saveVehicle=()=>{const v=$('newVehicle')?.value.trim();if(!v)return alert('请输入车辆号码');localStorage.setItem('today_vehicle',v);if($('vehicleText'))$('vehicleText').textContent=v;window.closeVehicle();if(window.Auth?.addLog)Auth.addLog('车辆更换',`更换车辆为: ${v}`);};
  window.shareOrder=async()=>{const route=Auth.getCurrentRoute(),orders=getLocalOrders(),n=orders.filter(x=>x.isNew).length,total=orders.length;const text=`天友智配One\n${localStorage.getItem('today_order_date')||todayKey()}\n${route}\n🚚 ${localStorage.getItem('today_vehicle')||'渝DK7692'}\n${n?`⚠️ 新${n}家、总${total}家`:`${total}家`}\n总重量 ${$('totalWeight')?.textContent||'0 kg'}`;try{if(navigator.share)await navigator.share({title:'今日运单',text});else if(navigator.clipboard){await navigator.clipboard.writeText(text);alert('📋 运单信息已复制');}else alert(text);}catch(_){} };
  window.goBack=()=>{window.location.href='../home.html';};
  window.logout=()=>{if(confirm('确定退出登录吗？'))Auth.logout();};
  document.addEventListener('DOMContentLoaded',async()=>{if(!window.Auth||!Auth.checkAuth())return;const route=Auth.getCurrentRoute(),vehicle=localStorage.getItem('today_vehicle')||'渝DK7692';initHeader(route,vehicle);const result=await loadOrders(route);renderRoute(result.orders,result.totalWeight);document.addEventListener('click',e=>{const m=$('menuPanel'),b=document.querySelector('.menu-btn');if(m&&!m.contains(e.target)&&!b?.contains(e.target))m.style.display='none';});});
})();