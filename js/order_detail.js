/* 天友智配One - 今日运单详情 */
(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  function readJSON(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function cleanName(value) {
    return String(value || '')
      .replace(/[\u3000]/g, ' ')
      .replace(/^\s*[\d０-９]+[、.．)）\s-]*/u, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function normalizeNameKey(value) {
    return cleanName(value).replace(/[\s，,。；;：:（）()【】\[\]]/g, '');
  }

  function normalizeStore(item, index) {
    if (typeof item === 'string') {
      return {
        code: String(index + 1).padStart(2, '0'),
        name: cleanName(item),
        nav: '',
        weight: 0,
        isNew: false
      };
    }

    const x = item || {};
    return {
      code: String(x.code || x.index || index + 1).padStart(2, '0'),
      name: cleanName(x.name || x.storeName || x.shopName || x['门店名称']),
      nav: String(x.nav || x.navigation || x.url || x.amap || x['导航'] || '').trim(),
      weight: parseWeight(x.weight ?? x['重量'] ?? 0),
      isNew: Boolean(x.isNew || x.newStore || x.is_new)
    };
  }

  function normalizeOrders(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    return raw.map(normalizeStore).filter(item => {
      if (!item.name) return false;
      const key = normalizeNameKey(item.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getBaseStores(route) {
    const local = readJSON('base_data', []);
    if (Array.isArray(local) && local.length) return local;

    const cached = readJSON(`route_cache_${route}`, null);
    if (Array.isArray(cached?.stores) && cached.stores.length) return cached.stores;

    return [];
  }

  function matchBaseStore(order, baseStores) {
    const orderKey = normalizeNameKey(order.name);
    if (!orderKey) return null;

    return baseStores.find(store => {
      const name = cleanName(store?.name || store?.storeName || store?.shopName);
      const key = normalizeNameKey(name);
      if (key && key === orderKey) return true;

      const code = String(store?.code || '').padStart(2, '0');
      return code && code === String(order.code || '').padStart(2, '0');
    }) || null;
  }

  /*
   * 核心规则：
   * 1. 基准门店严格按照 base_data 顺序。
   * 2. 运单中未匹配的新增门店统一放到最后。
   * 3. 基准门店的编号、名称、导航优先使用基准数据。
   * 4. 同一门店只保留一条。
   */
  function sortByBaseRoute(orders, baseStores) {
    const source = normalizeOrders(orders);
    if (!baseStores.length) {
      return source.map((item, index) => ({ ...item, displayCode: String(index + 1).padStart(2, '0') }));
    }

    const matched = [];
    const newStores = [];
    const used = new Set();

    baseStores.forEach((base, baseIndex) => {
      const baseName = cleanName(base?.name || base?.storeName || base?.shopName);
      const baseKey = normalizeNameKey(baseName);
      const baseCode = String(base?.code || baseIndex + 1).padStart(2, '0');

      const orderIndex = source.findIndex(order => {
        if (used.has(order)) return false;
        const orderKey = normalizeNameKey(order.name);
        const orderCode = String(order.code || '').padStart(2, '0');
        return (baseKey && orderKey === baseKey) || (orderCode && orderCode === baseCode && !orderKey);
      });

      if (orderIndex === -1) return;

      const order = source[orderIndex];
      used.add(order);
      matched.push({
        ...order,
        code: baseCode,
        displayCode: baseCode,
        name: baseName || order.name,
        nav: String(base?.nav || base?.navigation || base?.url || base?.amap || order.nav || '').trim(),
        isNew: false
      });
    });

    source.forEach(order => {
      if (used.has(order)) return;
      const base = matchBaseStore(order, baseStores);
      if (base) return;
      newStores.push({
        ...order,
        isNew: true,
        displayCode: ''
      });
    });

    newStores.forEach((item, index) => {
      item.displayCode = String(matched.length + index + 1).padStart(2, '0');
    });

    return matched.concat(newStores);
  }

  function parseWeight(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const match = String(value || '').replace(/,/g, '').match(/\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }

  function getLocalOrders() {
    const savedDate = localStorage.getItem('today_order_date');
    if (savedDate && savedDate !== todayKey()) return [];
    return readJSON('today_orders', []);
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

    orders.forEach((store) => {
      const row = document.createElement('div');
      row.className = 'store-item';

      const idx = document.createElement('span');
      idx.className = 'store-index';
      idx.textContent = `${store.displayCode || store.code}、`;

      const name = document.createElement('span');
      name.className = 'store-name';
      name.textContent = store.name;
      if (store.isNew) {
        name.innerHTML = '';
        const icon = document.createElement('span');
        icon.textContent = '⚠️ ';
        icon.title = '新增门店';
        name.appendChild(icon);
        name.appendChild(document.createTextNode(store.name));
      }

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

    if ($('storeCount')) $('storeCount').textContent = String(orders.length);

    const calculated = orders.reduce((sum, item) => sum + parseWeight(item.weight), 0);
    const weight = totalWeightValue !== '' && totalWeightValue !== null && totalWeightValue !== undefined
      ? parseWeight(totalWeightValue)
      : calculated;
    if ($('totalWeight')) $('totalWeight').textContent = `${Number(weight.toFixed(2))} kg`;
  }

  async function loadOrders(route) {
    const baseStores = getBaseStores(route);
    const local = getLocalOrders();

    if (local.length) {
      return {
        orders: sortByBaseRoute(local, baseStores),
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
      const orders = sortByBaseRoute(rawOrders, baseStores);
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
    if ($('routeName')) $('routeName').textContent = route || '未选择线路';
    if ($('menuRoute')) $('menuRoute').textContent = route || '未选择线路';
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
    const route = Auth.getCurrentRoute();
    const text = `天友智配One\n${todayKey()}\n${route}\n🚚 ${localStorage.getItem('today_vehicle') || '渝DK7692'}\n${$('storeCount')?.textContent || '0'}家门店\n总重量 ${$('totalWeight')?.textContent || '0 kg'}`;
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
