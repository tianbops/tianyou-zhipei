/* 天友智配One - 今日运单详情统一展示 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const readJSON = (key, fallback = null) => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };
  const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

  function baseStores() { return readJSON('base_data', []) || []; }

  function getSavedResult() {
    const date = localStorage.getItem('today_order_date');
    if (date && date !== todayKey()) return null;
    return readJSON('today_order_result', null);
  }

  function normalizeLegacy() {
    const raw = readJSON('today_orders', []);
    if (!Array.isArray(raw) || !raw.length) return { orders: [], totalWeight: '' };
    if (window.OrderEngine) {
      return OrderEngine.process(raw, {
        baseStores: baseStores(),
        route: Auth.getCurrentRoute(),
        date: todayKey(),
        vehicle: localStorage.getItem('today_vehicle') || '渝DK7692'
      });
    }
    return { orders: raw, totalWeight: localStorage.getItem('today_total_weight') || '' };
  }

  async function loadOrders(route) {
    const saved = getSavedResult();
    if (saved && Array.isArray(saved.orders)) return saved;

    const local = normalizeLegacy();
    if (local.orders.length) return local;

    try {
      const response = await fetch(`/api/history?date=${todayKey()}&route=${encodeURIComponent(route)}`, { cache: 'no-store' });
      if (!response.ok) return local;
      const data = await response.json();
      const record = Array.isArray(data) ? (data.find(x => x?.date === todayKey() && (!x.route || x.route === route)) || data[0]) : data;
      const raw = record?.orders || record?.today_orders || record?.data?.orders || [];
      const result = window.OrderEngine ? OrderEngine.process(raw, { baseStores: baseStores(), route, date: todayKey(), vehicle: record?.vehicle || localStorage.getItem('today_vehicle') || '渝DK7692' }) : { orders: raw, totalWeight: record?.totalWeight || '' };
      if (result.orders.length) {
        localStorage.setItem('today_orders', JSON.stringify(result.orders));
        localStorage.setItem('today_order_date', todayKey());
        localStorage.setItem('today_order_result', JSON.stringify(result));
        localStorage.setItem('today_total_weight', String(result.totalWeight || '0'));
      }
      return result;
    } catch (e) { console.warn('今日运单 API 读取失败:', e); return local; }
  }

  function render(result) {
    const orders = Array.isArray(result.orders) ? result.orders : [];
    const box = $('routeList'); box.innerHTML = '';
    $('storeCount').textContent = String(orders.length);
    $('totalWeight').textContent = `${Number(result.totalWeight || 0).toFixed(2).replace(/\.00$/,'')} kg`;
    if (!orders.length) { box.innerHTML = '<div class="empty-tip"><span class="icon">📭</span>今日暂无配送数据</div>'; return; }

    orders.forEach((store, i) => {
      const row = document.createElement('div'); row.className = 'store-item';
      const idx = document.createElement('span'); idx.className = 'store-index'; idx.textContent = `${String(i+1).padStart(2,'0')}、`;
      const name = document.createElement('span'); name.className = 'store-name';
      if (store.isNew) { const mark = document.createElement('span'); mark.className = 'new-mark'; mark.textContent = '⚠️'; name.appendChild(mark); }
      name.appendChild(document.createTextNode(store.name || '未命名门店'));
      const nav = document.createElement('button'); nav.className = 'nav-btn'; nav.type = 'button'; nav.textContent = '导航';
      nav.onclick = () => { if (!store.nav) return alert('该门店暂无导航地址'); window.location.href = store.nav; };
      row.append(idx, name, nav); box.appendChild(row);
    });
  }

  function initHeader(route, vehicle) { $('routeName').textContent = route || '未选择线路'; $('menuRoute').textContent = route || '未选择线路'; $('todayDate').textContent = todayKey(); $('vehicleText').textContent = vehicle || '渝DK7692'; $('newVehicle').value = vehicle || '渝DK7692'; }
  window.toggleMenu = () => { const m=$('menuPanel'); m.style.display=m.style.display==='block'?'none':'block'; };
  window.openVehicle = () => { $('vehicleDialog').style.display='flex'; $('menuPanel').style.display='none'; };
  window.closeVehicle = () => { $('vehicleDialog').style.display='none'; };
  window.saveVehicle = () => { const v=$('newVehicle').value.trim(); if(!v)return alert('请输入车辆号码'); localStorage.setItem('today_vehicle',v); $('vehicleText').textContent=v; window.closeVehicle(); if(window.Auth?.addLog) Auth.addLog('车辆更换',`更换车辆为: ${v}`); };
  window.shareOrder = async () => { const route=Auth.getCurrentRoute(); const t=`天友智配One\n${todayKey()}\n${route}\n🚚 ${localStorage.getItem('today_vehicle')||'渝DK7692'}\n${$('storeCount').textContent}家门店\n总重量 ${$('totalWeight').textContent}`; try { if(navigator.share) await navigator.share({title:'今日运单',text:t}); else if(navigator.clipboard){await navigator.clipboard.writeText(t);alert('📋 运单信息已复制');} else alert(t);} catch(_){} };
  window.goBack = () => { window.location.href='../home.html'; };
  window.logout = () => { if(confirm('确定退出登录吗？')) Auth.logout(); };

  document.addEventListener('DOMContentLoaded', async () => {
    if (!window.Auth || !Auth.checkAuth()) return;
    const route=Auth.getCurrentRoute(), vehicle=localStorage.getItem('today_vehicle')||'渝DK7692';
    initHeader(route,vehicle); render(await loadOrders(route));
    document.addEventListener('click', e => { const m=$('menuPanel'), b=document.querySelector('.menu-btn'); if(m&&!m.contains(e.target)&&!b?.contains(e.target))m.style.display='none'; });
  });
})();
