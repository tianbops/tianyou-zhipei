/* 天友智配One - 首页业务逻辑 */
(function () {
  'use strict';

  let baseStores = [];
  let parsedOrders = [];

  const $ = (id) => document.getElementById(id);

  function showToast(message, type = '') {
    let toast = $('homeToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'homeToast';
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 2600);
  }

  function showError(message) {
    const box = $('error-box');
    if (!box) return;
    box.textContent = '页面错误：' + message;
    box.classList.add('show');
    setTimeout(() => box.classList.remove('show'), 5000);
  }

  function todayKey() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function readJSON(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function normalizeName(name) {
    return String(name || '')
      .replace(/[\u3000]/g, ' ')
      .replace(/[，,。；;：:]+$/g, '')
      .replace(/^\d+[、.．)）\s-]*/, '')
      .trim();
  }

  function storeCode(store, index) {
    return String(store?.code || store?.id || index + 1).padStart(2, '0');
  }

  function storeName(store) {
    return String(store?.name || store?.storeName || store?.shopName || '').trim();
  }

  function getBaseStoresFromSources(route) {
    const candidates = [
      readJSON('base_data', null),
      readJSON(`route_cache_${route}`, null)?.stores,
      readJSON('route_cache_' + route, null)?.base_data
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate) && candidate.length) return candidate;
    }
    return [];
  }

  async function loadBaseStores() {
    const route = Auth.getCurrentRoute();
    baseStores = getBaseStoresFromSources(route);

    try {
      const response = await fetch(`/api/route/${encodeURIComponent(route)}`, { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        const stores = Array.isArray(data) ? data : (data.stores || data.data || []);
        if (Array.isArray(stores) && stores.length) {
          baseStores = stores;
          localStorage.setItem('base_data', JSON.stringify(stores));
          const cached = readJSON(`route_cache_${route}`, {});
          localStorage.setItem(`route_cache_${route}`, JSON.stringify({ ...cached, route, stores }));
        }
      }
    } catch (_) {
      // API 不可用时继续使用本地基准数据
    }
    return baseStores;
  }

  function getTodayOrders() {
    return Auth.getTodayOrders ? Auth.getTodayOrders() : readJSON('today_orders', null);
  }

  function getTotalWeight(orders) {
    if (!Array.isArray(orders)) return 0;
    return orders.reduce((sum, item) => {
      const value = Number(item?.weight ?? item?.totalWeight ?? item?.重量 ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);
  }

  function updateHomeSummary() {
    const orders = getTodayOrders();
    const count = Array.isArray(orders) ? orders.length : 0;
    const weight = getTotalWeight(orders);
    const route = Auth.getCurrentRoute();
    const vehicle = localStorage.getItem('today_vehicle') || '';

    if ($('menuRoute')) $('menuRoute').textContent = route || '未选择线路';
    if ($('homeRoute')) $('homeRoute').textContent = vehicle ? `🚚 ${vehicle}` : `🚚 ${route || ''}`;
    if ($('storeCount')) $('storeCount').textContent = count ? `${count}家门店` : '无数据';
    if ($('totalWeight')) $('totalWeight').textContent = weight ? `${Number(weight.toFixed(2))} kg` : '无数据';
    if ($('statusDot')) $('statusDot').style.background = count ? '#27AE60' : '#5A6A7A';
  }

  function sortOrdersByBase(orders) {
    const list = Array.isArray(orders) ? orders : [];
    const rank = new Map();
    baseStores.forEach((store, i) => {
      const name = storeName(store);
      if (name) rank.set(name, i);
      if (store?.code) rank.set(String(store.code), i);
    });

    return list.map((item, originalIndex) => ({ ...item, _originalIndex: originalIndex }))
      .sort((a, b) => {
        const an = normalizeName(a?.name || a?.storeName || a?.shopName || a?.门店名称);
        const bn = normalizeName(b?.name || b?.storeName || b?.shopName || b?.门店名称);
        const ai = rank.has(an) ? rank.get(an) : (rank.has(String(a?.code)) ? rank.get(String(a.code)) : 999999);
        const bi = rank.has(bn) ? rank.get(bn) : (rank.has(String(b?.code)) ? rank.get(String(b.code)) : 999999);
        return ai - bi || a._originalIndex - b._originalIndex;
      })
      .map(({ _originalIndex, ...item }) => item);
  }

  function parseText(text) {
    const lines = String(text || '').split(/\r?\n/).map(normalizeName).filter(Boolean);
    const result = [];
    const seen = new Set();

    for (const line of lines) {
      let weight = 0;
      const weightMatch = line.match(/(\d+(?:\.\d+)?)\s*(?:kg|KG|千克|公斤)/i);
      if (weightMatch) weight = Number(weightMatch[1]);
      let name = line.replace(/\d+(?:\.\d+)?\s*(?:kg|KG|千克|公斤)/ig, '').trim();
      const codeMatch = name.match(/^(\d{1,3})[、.．)）\s-]+(.+)$/);
      const code = codeMatch ? codeMatch[1].padStart(2, '0') : '';
      name = normalizeName(codeMatch ? codeMatch[2] : name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      result.push({ code, name, weight });
    }
    return sortOrdersByBase(result);
  }

  function renderParseStatus(status, count = 0) {
    const box = $('parseStatus');
    if (!box) return;
    box.classList.add('active');
    if ($('statusIcon')) $('statusIcon').textContent = status === 'success' ? '✅' : status === 'error' ? '⚠️' : '⏳';
    if ($('statusText')) $('statusText').textContent = status === 'success' ? '解析完成' : status === 'error' ? '解析失败' : '正在解析...';
    if ($('progressBar')) $('progressBar').style.width = status === 'success' ? '100%' : status === 'error' ? '100%' : '50%';
    if ($('statusCount')) $('statusCount').textContent = count ? `识别 ${count} 家门店` : '';
  }

  function renderTags(items) {
    const box = $('parsedTags');
    if (!box) return;
    box.innerHTML = '';
    items.slice(0, 50).forEach((item, i) => {
      const tag = document.createElement('span');
      tag.textContent = `${String(i + 1).padStart(2, '0')} ${item.name}`;
      tag.style.cssText = 'background:rgba(36,87,166,.18);padding:4px 7px;border-radius:7px;color:#AFC7E8;font-size:10px;';
      box.appendChild(tag);
    });
  }

  window.toggleUpload = function () {
    const overlay = $('uploadOverlay');
    if (!overlay) return;
    overlay.classList.toggle('active');
    if (overlay.classList.contains('active')) $('manualOrderInput')?.focus();
  };

  window.openHomeMenu = function () {
    const menu = $('homeMenu');
    if (!menu) return;
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  };

  window.goToRouteEdit = function () { window.location.href = 'pages/route_edit.html'; };
  window.goToOrderDetail = function () { window.location.href = 'pages/order_detail.html'; };
  window.goToHistory = function () { window.location.href = 'pages/history.html'; };
  window.logout = function () { Auth.logout(); };

  window.clearManualInput = function () {
    if ($('manualOrderInput')) $('manualOrderInput').value = '';
    if ($('charCount')) $('charCount').textContent = '0';
    parsedOrders = [];
    renderParseStatus('idle');
    renderTags([]);
  };

  window.loadExampleData = function () {
    const names = baseStores.slice(0, 3).map(storeName).filter(Boolean);
    $('manualOrderInput').value = names.length ? names.join('\n') : '江北胡汪洋经销商\n中景隆贸易\n江北重庆兴农';
    $('manualOrderInput').dispatchEvent(new Event('input'));
  };

  window.pasteFromClipboard = async function () {
    try {
      $('manualOrderInput').value = await navigator.clipboard.readText();
      $('manualOrderInput').dispatchEvent(new Event('input'));
    } catch (_) {
      showToast('无法读取剪贴板，请长按输入框粘贴', 'warning');
    }
  };

  window.parseManualInput = function () {
    try {
      parsedOrders = parseText($('manualOrderInput')?.value || '');
      renderParseStatus(parsedOrders.length ? 'success' : 'error', parsedOrders.length);
      renderTags(parsedOrders);
      if (!parsedOrders.length) showToast('没有识别到有效门店', 'warning');
      return parsedOrders;
    } catch (e) {
      renderParseStatus('error');
      showError(e.message);
      return [];
    }
  };

  window.submitManualOrder = async function () {
    try {
      if (!parsedOrders.length) window.parseManualInput();
      if (!parsedOrders.length) {
        showToast('请先输入并解析运单', 'warning');
        return;
      }

      const orders = sortOrdersByBase(parsedOrders).map((item, index) => ({
        ...item,
        code: item.code || storeCode(baseStores[index] || {}, index),
        date: todayKey(),
        route: Auth.getCurrentRoute()
      }));

      localStorage.setItem('today_orders', JSON.stringify(orders));
      localStorage.setItem('today_order_date', todayKey());
      localStorage.setItem('today_order_source', 'manual');

      const route = Auth.getCurrentRoute();
      const history = readJSON('delivery_history', []);
      const entry = {
        date: todayKey(),
        route,
        vehicle: localStorage.getItem('today_vehicle') || '',
        stores: orders.length,
        totalWeight: getTotalWeight(orders),
        orders
      };
      const index = Array.isArray(history) ? history.findIndex(x => x?.date === entry.date && x?.route === route) : -1;
      const nextHistory = Array.isArray(history) ? [...history] : [];
      if (index >= 0) nextHistory[index] = entry; else nextHistory.unshift(entry);
      localStorage.setItem('delivery_history', JSON.stringify(nextHistory));

      if (Auth.saveUserOrderData) {
        const data = Auth.getUserOrderData(route) || {};
        data.today_orders = orders;
        data.delivery_history = nextHistory;
        data.lastOrderDate = todayKey();
        Auth.saveUserOrderData(route, data);
      }

      updateHomeSummary();
      showToast(`已录入 ${orders.length} 家门店`);
      $('uploadOverlay')?.classList.remove('active');
      setTimeout(() => window.goToOrderDetail(), 500);
    } catch (e) {
      showError(e.message);
    }
  };

  window.triggerUpload = function (type) {
    let input = document.getElementById('homeUploadInput');
    if (!input) {
      input = document.createElement('input');
      input.id = 'homeUploadInput';
      input.type = 'file';
      input.accept = type === 'album' ? 'image/*' : 'image/*,.txt,.csv,.xlsx,.xls';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', handleUploadFile);
    }
    input.value = '';
    input.click();
  };

  async function handleUploadFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    renderParseStatus('loading');
    try {
      if (file.type.startsWith('text/') || /\.csv$/i.test(file.name)) {
        const text = await file.text();
        $('manualOrderInput').value = text;
        window.parseManualInput();
        return;
      }
      if (file.type.startsWith('image/')) {
        showToast('运单图片已接收，AI OCR接口接入后将在这里自动提取', 'warning');
        renderParseStatus('success', 0);
        return;
      }
      showToast('暂不支持该文件类型', 'warning');
      renderParseStatus('error');
    } catch (e) {
      renderParseStatus('error');
      showError(e.message);
    }
  }

  document.addEventListener('DOMContentLoaded', async function () {
    try {
      if (typeof Auth === 'undefined') throw new Error('Auth 未加载');
      if (!Auth.checkAuth()) return;
      await loadBaseStores();
      updateHomeSummary();

      const input = $('manualOrderInput');
      input?.addEventListener('input', function () {
        if ($('charCount')) $('charCount').textContent = String(this.value.length);
      });

      document.addEventListener('click', function (event) {
        const menu = $('homeMenu');
        const button = document.querySelector('.menu-btn');
        if (menu && menu.style.display === 'block' && !menu.contains(event.target) && !button?.contains(event.target)) {
          menu.style.display = 'none';
        }
      });
    } catch (e) {
      console.error(e);
      showError(e.message || '首页初始化失败');
    }
  });
})();
