/* 天友智配One - 今日运单详情 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const readJSON = (key, fallback = null) => {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
  };
  const todayKey = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  function normalizeOrder(item, index) {
    return {
      code: String(item?.code || item?.id || index + 1).padStart(2, '0'),
      name: String(item?.name || item?.storeName || item?.shopName || item?.门店名称 || '').trim(),
      nav: String(item?.nav || item?.navigation || item?.url || item?.导航 || '').trim(),
      weight: Number(item?.weight ?? item?.totalWeight ?? item?.重量 ?? 0) || 0
    };
  }

  function normalizeOrders(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw.map(normalizeOrder).filter(x => {
      const key = x.name || x.code;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getLocalOrders() {
    const raw = readJSON('today_orders', []);
    const savedDate = localStorage.getItem('today_order_date');
    return savedDate && savedDate !== todayKey() ? [] : normalizeOrders(raw);
  }

  function totalWeight(orders) {
    return orders.reduce((sum, x) => sum + x.weight, 0);
  }

  function showEmpty(text = '今日暂无配送数据') {
    $('routeList').innerHTML = `<div class="empty-tip"><span class="icon">📭</span>${text}</div>`;
    $('storeCount').textContent = '0';
    $('totalWeight').textContent = '0 kg';
  }

  function renderRoute(orders) {
    const box = $('routeList');
    box.innerHTML = '';
    if (!orders.length) return showEmpty();

    orders.forEach((store, index) => {
      const row = document.createElement('div');
      row.className = 'store-item';

      const idx = document.createElement('span');
      idx.className = 'store-index';
      idx.textContent = `${String(index + 1).padStart(2, '0')}、`;

      const name = document.createElement('span');
      name.className = 'store-name';
      name.textContent = store.name || '未命名门店';

      const nav = document.createElement('button');
      nav.className = 'nav-btn';
      nav.type = 'button';
      nav.textContent = '导航';
      nav.addEventListener('click', () => {
        if (!store.nav) return alert('该门店暂无导航地址');
        window.open(store.nav, '_blank', 'noopener,noreferrer');
      });

      row.append(idx, name, nav);
      box.appendChild(row);
    });

    $('storeCount').textContent = String(orders.length);
    const weight = totalWeight(orders);
    $('totalWeight').textContent = `${Number(weight.toFixed(2))} kg`;
  }

  async function loadOrders(route) {
    // 1. 当前会话数据优先，保证首页刚解析完成后立即可查看
    let orders = getLocalOrders();
    if (orders.length) return orders;

    // 2. 历史 API 作为跨设备/刷新后的兜底
    try {
      const response = await fetch(`/api/history?date=${todayKey()}&route=${encodeURIComponent(route)}`, { cache: 'no-store' });
      if (!response.ok) return [];
      const data = await response.json();
      let record = data;
      if (Array.isArray(data)) record = data.find(x => x?.date === todayKey() && (!x.route || x.route === route)) || data[0];
      const apiOrders = record?.orders || record?.today_orders || record?.data?.orders || [];
      orders = normalizeOrders(apiOrders);
      if (orders.length) {
        localStorage.setItem('today_orders', JSON.stringify(orders));
        localStorage.setItem('today_order_date', todayKey());
      }
    } catch (e) {
      console.warn('今日运单 API 读取失败:', e);
    }
    return orders;
  }

  function initHeader(route) {
    $('routeName').textContent = route || '未选择线路';
    $('menuRoute').textContent = route || '未选择线路';
    $('todayDate').textContent = todayKey();
    $('vehicleText').textContent = localStorage.getItem('today_vehicle') || '渝DK7692';
  }

  window.toggleMenu = function () {
    const menu = $('menuPanel');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  };

  window.openVehicle = function () {
    $('vehicleDialog').style.display = 'flex';
    $('menuPanel').style.display = 'none';
  };
  window.closeVehicle = function () { $('vehicleDialog').style.display = 'none'; };
  window.saveVehicle = function () {
    const value = $('newVehicle').value.trim();
    if (!value) return alert('请输入车辆号码');
    localStorage.setItem('today_vehicle', value);
    $('vehicleText').textContent = value;
    window.closeVehicle();
    if (window.Auth?.addLog) Auth.addLog('车辆更换', `更换车辆为: ${value}`);
  };

  window.shareOrder = async function () {
    const route = Auth.getCurrentRoute();
    const text = `天友智配One\n${todayKey()} ${route}\n🚚 ${localStorage.getItem('today_vehicle') || '渝DK7692'}\n${$('storeCount').textContent}家门店\n总重量 ${$('totalWeight').textContent}`;
    try {
      if (navigator.share) await navigator.share({ title: '今日运单', text });
      else if (navigator.clipboard) { await navigator.clipboard.writeText(text); alert('📋 运单信息已复制'); }
      else alert(text);
    } catch (_) {}
  };

  window.goBack = function () { window.location.href = '../home.html'; };
  window.logout = function () { if (confirm('确定退出登录吗？')) Auth.logout(); };

  document.addEventListener('DOMContentLoaded', async function () {
    if (!window.Auth || !Auth.checkAuth()) return;
    const route = Auth.getCurrentRoute();
    initHeader(route);
    const orders = await loadOrders(route);
    renderRoute(orders);

    document.addEventListener('click', function (event) {
      const menu = $('menuPanel');
      const button = document.querySelector('.menu-btn');
      if (menu && !menu.contains(event.target) && !button?.contains(event.target)) menu.style.display = 'none';
    });
  });
})();
