/* 天友智配One - 今日运单详情 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);
  const readJSON = (key, fallback = null) => {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) { return fallback; }
  };

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function normalizeOrder(item, index) {
    if (typeof item === 'string') {
      return { code: String(index + 1).padStart(2, '0'), name: item.trim(), nav: '', weight: 0 };
    }
    const x = item || {};
    return {
      code: String(x.code || x.index || index + 1).padStart(2, '0'),
      name: String(x.name || x.storeName || x.shopName || x['门店名称'] || '').trim(),
      nav: String(x.nav || x.navigation || x.url || x['导航'] || '').trim(),
      weight: Number(x.weight ?? x['重量'] ?? 0) || 0
    };
  }

  function normalizeOrders(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw.map(normalizeOrder).filter(item => {
      if (!item.name) return false;
      const key = item.name.replace(/\s+/g, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getLocalOrders() {
    const savedDate = localStorage.getItem('today_order_date');
    if (savedDate && savedDate !== todayKey()) return [];
    return normalizeOrders(readJSON('today_orders', []));
  }

  function parseWeight(value) {
    if (typeof value === 'number') return value;
    const match = String(value || '').replace(/,/g, '').match(/[\d.]+/);
    return match ? Number(match[0]) : 0;
  }

  function renderRoute(orders, totalWeightValue = '') {
    const box = $('routeList');
    box.innerHTML = '';

    if (!orders.length) {
      box.innerHTML = '<div class="empty-tip"><span class="icon">📭</span>今日暂无配送数据</div>';
      $('storeCount').textContent = '0';
      $('totalWeight').textContent = '0 kg';
      return;
    }

    orders.forEach((store, index) => {
      const row = document.createElement('div');
      row.className = 'store-item';

      const idx = document.createElement('span');
      idx.className = 'store-index';
      idx.textContent = `${String(index + 1).padStart(2, '0')}、`;

      const name = document.createElement('span');
      name.className = 'store-name';
      name.textContent = store.name;

      const nav = document.createElement('button');
      nav.className = 'nav-btn';
      nav.type = 'button';
      nav.textContent = '导航';
      nav.addEventListener('click', () => {
        if (!store.nav) {
          alert('该门店暂无导航地址');
          return;
        }
        window.location.href = store.nav;
      });

      row.append(idx, name, nav);
      box.appendChild(row);
    });

    $('storeCount').textContent = String(orders.length);

    const calculated = orders.reduce((sum, item) => sum + parseWeight(item.weight), 0);
    const weight = totalWeightValue !== '' ? String(totalWeightValue) : (calculated ? calculated.toFixed(2) : '0');
    $('totalWeight').textContent = `${weight.replace(/\s*kg$/i, '')} kg`;
  }

  async function loadOrders(route) {
    const local = getLocalOrders();
    if (local.length) {
      return {
        orders: local,
        totalWeight: localStorage.getItem('today_total_weight') || ''
      };
    }

    try {
      const response = await fetch(`/api/history?date=${todayKey()}&route=${encodeURIComponent(route)}`, { cache: 'no-store' });
      if (!response.ok) return { orders: [], totalWeight: '' };

      const data = await response.json();
      let record = data;
      if (Array.isArray(data)) {
        record = data.find(x => x?.date === todayKey() && (!x.route || x.route === route)) || data[0];
      }

      const rawOrders = record?.orders || record?.today_orders || record?.data?.orders || [];
      const orders = normalizeOrders(rawOrders);
      const totalWeight = record?.totalWeight ?? record?.weight ?? record?.data?.totalWeight ?? '';

      if (orders.length) {
        localStorage.setItem('today_orders', JSON.stringify(orders));
        localStorage.setItem('today_order_date', todayKey());
        if (totalWeight !== '') localStorage.setItem('today_total_weight', String(totalWeight));
      }

      return { orders, totalWeight };
    } catch (e) {
      console.warn('今日运单 API 读取失败:', e);
      return { orders: [], totalWeight: '' };
    }
  }

  function initHeader(route, vehicle) {
    $('routeName').textContent = route || '未选择线路';
    $('menuRoute').textContent = route || '未选择线路';
    $('todayDate').textContent = todayKey();
    $('vehicleText').textContent = vehicle || '渝DK7692';
    $('newVehicle').value = vehicle || '渝DK7692';
  }

  window.toggleMenu = function () {
    const menu = $('menuPanel');
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  };

  window.openVehicle = function () {
    $('vehicleDialog').style.display = 'flex';
    $('menuPanel').style.display = 'none';
  };

  window.closeVehicle = function () {
    $('vehicleDialog').style.display = 'none';
  };

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
    const text = `天友智配One\n${todayKey()}\n${route}\n🚚 ${localStorage.getItem('today_vehicle') || '渝DK7692'}\n${$('storeCount').textContent}家门店\n总重量 ${$('totalWeight').textContent}`;
    try {
      if (navigator.share) await navigator.share({ title: '今日运单', text });
      else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        alert('📋 运单信息已复制');
      } else alert(text);
    } catch (_) {}
  };

  window.goBack = function () { window.location.href = '../home.html'; };
  window.logout = function () { if (confirm('确定退出登录吗？')) Auth.logout(); };

  document.addEventListener('DOMContentLoaded', async function () {
    if (!window.Auth || !Auth.checkAuth()) return;

    const route = Auth.getCurrentRoute();
    const vehicle = localStorage.getItem('today_vehicle') || '渝DK7692';
    initHeader(route, vehicle);

    const result = await loadOrders(route);
    renderRoute(result.orders, result.totalWeight);

    document.addEventListener('click', function (event) {
      const menu = $('menuPanel');
      const button = document.querySelector('.menu-btn');
      if (menu && !menu.contains(event.target) && !button?.contains(event.target)) {
        menu.style.display = 'none';
      }
    });
  });
})();
