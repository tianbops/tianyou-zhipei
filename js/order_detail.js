/* 天友智配One - 今日运单详情 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  const readJSON = (key, fallback = null) => {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  };

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function normalizeRoute(route) {
    if (window.Auth?.formatRouteCode) return Auth.formatRouteCode(route);
    const text = String(route || '').trim();
    const match = text.match(/^(\d+)号线$/);
    return match ? `${String(parseInt(match[1], 10)).padStart(2, '0')}号线` : text;
  }

  function normalizeOrder(item, index) {
    if (typeof item === 'string') {
      return {
        code: String(index + 1).padStart(2, '0'),
        name: item.trim(),
        nav: '',
        weight: 0,
        isNew: false
      };
    }

    const x = item || {};
    return {
      code: String(x.code || x.index || x.no || index + 1).padStart(2, '0'),
      name: String(x.name || x.storeName || x.shopName || x.store || x['门店名称'] || '').trim(),
      nav: String(x.nav || x.navigation || x.navigationUrl || x.url || x['导航'] || '').trim(),
      weight: Number(x.weight ?? x['重量'] ?? 0) || 0,
      isNew: Boolean(x.isNew || x.newStore || x.is_new)
    };
  }

  function normalizeOrders(raw) {
    if (!Array.isArray(raw)) return [];

    const seen = new Set();
    return raw
      .map(normalizeOrder)
      .filter(item => {
        if (!item.name) return false;
        const key = item.name.replace(/[\s　]+/g, '').toLowerCase();
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

  function formatWeight(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  }

  function resolveNavigation(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (/^(https?:|amapuri:|androidamap:|iosamap:)/i.test(value)) return value;
    return `https://uri.amap.com/search?keyword=${encodeURIComponent(value)}`;
  }

  function renderRoute(orders, totalWeightValue = '') {
    const box = $('routeList');
    if (!box) return;
    box.innerHTML = '';

    if (!orders.length) {
      box.innerHTML = '<div class="empty-tip"><span class="icon">📭</span>今日暂无配送数据</div>';
      if ($('storeCount')) $('storeCount').textContent = '0';
      if ($('totalWeight')) $('totalWeight').textContent = '0 kg';
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
        const target = resolveNavigation(store.nav || store.name);
        if (!target) {
          alert('该门店暂无导航地址');
          return;
        }
        window.location.href = target;
      });

      row.append(idx, name, nav);
      box.appendChild(row);
    });

    if ($('storeCount')) $('storeCount').textContent = String(orders.length);

    const calculated = orders.reduce((sum, item) => sum + parseWeight(item.weight), 0);
    const sourceWeight = totalWeightValue !== '' && totalWeightValue !== null && totalWeightValue !== undefined
      ? parseWeight(totalWeightValue)
      : calculated;
    if ($('totalWeight')) $('totalWeight').textContent = `${formatWeight(sourceWeight)} kg`;
  }

  function extractHistoryRecord(data, route) {
    if (!data) return null;

    if (Array.isArray(data)) {
      return data.find(item => {
        const itemRoute = normalizeRoute(item?.route || item?.line || item?.['线路'] || '');
        return (!itemRoute || itemRoute === normalizeRoute(route)) && (!item?.date || item.date === todayKey());
      }) || data[0] || null;
    }

    if (data.result) {
      if (typeof data.result === 'string') {
        try { return extractHistoryRecord(JSON.parse(data.result), route); } catch (_) {}
      }
      return extractHistoryRecord(data.result, route);
    }

    return data.data || data;
  }

  function extractOrders(record) {
    if (!record) return [];
    return record.orders || record.today_orders || record.orderData || record.data?.orders || record.data?.today_orders || [];
  }

  function extractTotalWeight(record) {
    if (!record) return '';
    return record.totalWeight ?? record.total_weight ?? record.weight ?? record.totalKg ?? record.data?.totalWeight ?? '';
  }

  async function loadOrders(route) {
    const local = getLocalOrders();
    const localWeight = localStorage.getItem('today_total_weight');
    if (local.length) {
      return { orders: local, totalWeight: localWeight || '' };
    }

    try {
      const response = await fetch(`/api/history?date=${encodeURIComponent(todayKey())}&route=${encodeURIComponent(route)}`, {
        cache: 'no-store'
      });
      if (!response.ok) return { orders: [], totalWeight: '' };

      const data = await response.json();
      const record = extractHistoryRecord(data, route);
      const orders = normalizeOrders(extractOrders(record));
      const totalWeight = extractTotalWeight(record);

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
    const line = normalizeRoute(route);
    if ($('routeName')) $('routeName').textContent = line || '未选择线路';
    if ($('menuRoute')) $('menuRoute').textContent = line || '未选择线路';
    if ($('todayDate')) $('todayDate').textContent = todayKey();
    if ($('vehicleText')) $('vehicleText').textContent = vehicle || '渝DK7692';
    if ($('newVehicle')) $('newVehicle').value = vehicle || '渝DK7692';
  }

  window.toggleMenu = function () {
    const menu = $('menuPanel');
    if (menu) menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  };

  window.openVehicle = function () {
    if ($('vehicleDialog')) $('vehicleDialog').style.display = 'flex';
    if ($('menuPanel')) $('menuPanel').style.display = 'none';
  };

  window.closeVehicle = function () {
    if ($('vehicleDialog')) $('vehicleDialog').style.display = 'none';
  };

  window.saveVehicle = function () {
    const value = $('newVehicle')?.value.trim();
    if (!value) return alert('请输入车辆号码');
    localStorage.setItem('today_vehicle', value);
    if ($('vehicleText')) $('vehicleText').textContent = value;
    window.closeVehicle();
    if (window.Auth?.addLog) Auth.addLog('车辆更换', `更换车辆为: ${value}`);
  };

  window.shareOrder = async function () {
    const route = normalizeRoute(Auth.getCurrentRoute());
    const text = `天友智配One\n${todayKey()}\n${route}\n🚚 ${localStorage.getItem('today_vehicle') || '渝DK7692'}\n${$('storeCount')?.textContent || 0}家门店\n总重量 ${$('totalWeight')?.textContent || '0 kg'}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: '今日运单', text });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        alert('📋 运单信息已复制');
      } else {
        alert(text);
      }
    } catch (_) {}
  };

  window.goBack = function () {
    window.location.href = '../home.html';
  };

  window.logout = function () {
    if (confirm('确定退出登录吗？')) Auth.logout();
  };

  document.addEventListener('DOMContentLoaded', async function () {
    if (!window.Auth || !Auth.checkAuth()) return;

    const route = normalizeRoute(Auth.getCurrentRoute());
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
