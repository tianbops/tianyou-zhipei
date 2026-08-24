/* 天友智配One - 首页业务逻辑 */
(function () {
  'use strict';

  let baseStores = [];
  let parsedOrders = [];
  const $ = id => document.getElementById(id);

  function toast(message, type = '') {
    let el = $('homeToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'homeToast';
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.className = `toast show ${type}`;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.remove('show'), 2800);
  }

  function error(message) {
    const box = $('error-box');
    if (!box) return;
    box.textContent = '页面错误：' + message;
    box.classList.add('show');
    setTimeout(() => box.classList.remove('show'), 5000);
  }

  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function readJSON(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) { return fallback; }
  }

  function normalizeName(name) {
    return String(name || '')
      .replace(/[\u3000]/g, ' ')
      .replace(/^[\s\d、.．)）_-]+/, '')
      .replace(/[，,。；;：:]$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function storeName(store) {
    return String(store?.name || store?.storeName || store?.shopName || '').trim();
  }

  function storeCode(store, index) {
    return String(store?.code || store?.id || index + 1).padStart(2, '0');
  }

  async function loadBaseStores() {
    const route = Auth.getCurrentRoute();
    const local = readJSON('base_data', null);
    const cached = readJSON(`route_cache_${route}`, null);
    baseStores = Array.isArray(local) && local.length
      ? local
      : (Array.isArray(cached?.stores) ? cached.stores : []);

    try {
      const response = await fetch(`/api/routes?route=${encodeURIComponent(route)}`, { cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        const stores = Array.isArray(data) ? data : (data?.stores || data?.data || []);
        if (Array.isArray(stores) && stores.length) {
          baseStores = stores;
          localStorage.setItem('base_data', JSON.stringify(stores));
          localStorage.setItem(`route_cache_${route}`, JSON.stringify({ route, stores }));
        }
      }
    } catch (_) {}
    return baseStores;
  }

  function rankOrders(list) {
    const rank = new Map();
    baseStores.forEach((s, i) => {
      const name = storeName(s);
      if (name) rank.set(name, i);
      if (s?.code) rank.set(String(s.code), i);
    });

    return (Array.isArray(list) ? list : [])
      .map((item, i) => ({ ...item, _i: i }))
      .sort((a, b) => {
        const an = normalizeName(a?.name || a?.storeName || a?.shopName || a?.门店名称);
        const bn = normalizeName(b?.name || b?.storeName || b?.shopName || b?.门店名称);
        const ai = rank.has(an) ? rank.get(an) : (rank.has(String(a?.code)) ? rank.get(String(a.code)) : 999999);
        const bi = rank.has(bn) ? rank.get(bn) : (rank.has(String(b?.code)) ? rank.get(String(b.code)) : 999999);
        return ai - bi || a._i - b._i;
      })
      .map(({ _i, ...item }) => item);
  }

  function totalWeight(orders) {
    return (Array.isArray(orders) ? orders : []).reduce((sum, item) => {
      const n = Number(item?.weight ?? item?.totalWeight ?? 0);
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  }

  function updateSummary() {
    const orders = Auth.getTodayOrders ? Auth.getTodayOrders() : readJSON('today_orders', []);
    const count = Array.isArray(orders) ? orders.length : 0;
    const storedWeight = Number.parseFloat(String(localStorage.getItem('today_total_weight') || '').replace(/[^\d.]/g, '')) || 0;
    const weight = storedWeight || totalWeight(orders);
    const route = Auth.getCurrentRoute();
    const vehicle = localStorage.getItem('today_vehicle') || '';

    if ($('menuRoute')) $('menuRoute').textContent = route || '未选择线路';
    if ($('homeRoute')) $('homeRoute').textContent = vehicle ? `🚚 ${vehicle}` : `🚚 ${route || ''}`;
    if ($('storeCount')) $('storeCount').textContent = count ? `${count}家门店` : '无数据';
    if ($('totalWeight')) $('totalWeight').textContent = weight ? `${Number(weight.toFixed(2))} kg` : '无数据';
    if ($('statusDot')) $('statusDot').style.background = count ? '#27AE60' : '#5A6A7A';
  }

  function renderStatus(status, count = 0, message = '') {
    const box = $('parseStatus');
    if (!box) return;
    box.classList.add('active');
    if ($('statusIcon')) $('statusIcon').textContent = status === 'success' ? '✅' : status === 'error' ? '⚠️' : '⏳';
    if ($('statusText')) $('statusText').textContent = message || (status === 'success' ? '解析完成' : status === 'error' ? '解析失败' : '正在解析...');
    if ($('progressBar')) $('progressBar').style.width = status === 'success' || status === 'error' ? '100%' : '50%';
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

  function parseText(text) {
    const result = [];
    const seen = new Set();
    for (const raw of String(text || '').split(/\r?\n/)) {
      let line = normalizeName(raw);
      if (!line) continue;
      const weightMatch = line.match(/(\d+(?:\.\d+)?)\s*(kg|KG|千克|公斤)/i);
      line = line.replace(/\d+(?:\.\d+)?\s*(kg|KG|千克|公斤)/ig, '').trim();
      const codeMatch = line.match(/^(\d{1,3})[、.．)）\s-]+(.+)$/);
      const code = codeMatch ? codeMatch[1].padStart(2, '0') : '';
      const name = normalizeName(codeMatch ? codeMatch[2] : line);
      if (!name || seen.has(name)) continue;
      if (/(总重量|合计|总计|车牌|车辆|日期|线路)/.test(name)) continue;
      seen.add(name);
      result.push({ code, name, weight: weightMatch ? Number(weightMatch[1]) : 0 });
    }
    return rankOrders(result);
  }

  async function imageToDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('图片读取失败'));
      reader.readAsDataURL(file);
    });
  }

  async function callOCR(file) {
    const route = Auth.getCurrentRoute();
    const image = await imageToDataURL(file);
    const response = await fetch('/api/ocr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image, route })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) throw new Error(data.error || `OCR接口错误 ${response.status}`);
    return data.data;
  }

  async function saveTodayOrders(orders, meta = {}) {
    const route = Auth.getCurrentRoute();
    const date = today();
    const normalized = rankOrders(orders).map((item, index) => ({
      ...item,
      code: item.code || storeCode(baseStores[index], index),
      date,
      route,
      status: item.status || '待配送'
    }));

    const weightValue = meta.totalWeight !== undefined && meta.totalWeight !== ''
      ? meta.totalWeight
      : totalWeight(normalized);

    localStorage.setItem('today_orders', JSON.stringify(normalized));
    localStorage.setItem('today_order_date', date);
    localStorage.setItem('today_order_source', meta.source || 'manual');
    localStorage.setItem('today_total_weight', String(weightValue));
    if (meta.vehicle) localStorage.setItem('today_vehicle', meta.vehicle);

    const history = readJSON('delivery_history', []);
    const entry = {
      date,
      route,
      vehicle: meta.vehicle || localStorage.getItem('today_vehicle') || '',
      stores: normalized.length,
      totalWeight: weightValue,
      orders: normalized
    };
    const next = Array.isArray(history) ? [...history] : [];
    const index = next.findIndex(x => x?.date === date && x?.route === route);
    if (index >= 0) next[index] = entry; else next.unshift(entry);
    localStorage.setItem('delivery_history', JSON.stringify(next));

    if (Auth.saveUserOrderData) {
      const data = Auth.getUserOrderData(route) || {};
      data.today_orders = normalized;
      data.today_vehicle = entry.vehicle;
      data.today_total_weight = weightValue;
      data.delivery_history = next;
      data.lastOrderDate = date;
      Auth.saveUserOrderData(route, data);
    }

    try {
      await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route, orders: normalized, totalWeight: weightValue, vehicle: entry.vehicle, date })
      });
    } catch (_) {}

    updateSummary();
    return normalized;
  }

  window.toggleUpload = function () {
    const overlay = $('uploadOverlay');
    if (!overlay) return;
    overlay.classList.toggle('active');
    if (overlay.classList.contains('active')) $('manualOrderInput')?.focus();
  };

  window.openHomeMenu = function () {
    const menu = $('homeMenu');
    if (menu) menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  };

  window.goToRouteEdit = () => { window.location.href = 'pages/route_edit.html'; };
  window.goToOrderDetail = () => { window.location.href = 'pages/order_detail.html'; };
  window.goToHistory = () => { window.location.href = 'pages/history.html'; };
  window.logout = () => Auth.logout();

  window.clearManualInput = function () {
    if ($('manualOrderInput')) $('manualOrderInput').value = '';
    if ($('charCount')) $('charCount').textContent = '0';
    parsedOrders = [];
    renderStatus('idle');
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
    } catch (_) { toast('无法读取剪贴板，请手动粘贴', 'warning'); }
  };

  window.parseManualInput = function () {
    try {
      parsedOrders = parseText($('manualOrderInput')?.value || '');
      renderStatus(parsedOrders.length ? 'success' : 'error', parsedOrders.length);
      renderTags(parsedOrders);
      if (!parsedOrders.length) toast('没有识别到有效门店', 'warning');
      return parsedOrders;
    } catch (e) {
      renderStatus('error'); error(e.message); return [];
    }
  };

  window.submitManualOrder = async function () {
    try {
      if (!parsedOrders.length) window.parseManualInput();
      if (!parsedOrders.length) return toast('请先输入并解析运单', 'warning');
      const orders = await saveTodayOrders(parsedOrders, { source: 'manual' });
      toast(`已录入 ${orders.length} 家门店`);
      $('uploadOverlay')?.classList.remove('active');
      setTimeout(window.goToOrderDetail, 500);
    } catch (e) { error(e.message); }
  };

  window.triggerUpload = function (type) {
    let input = $('homeUploadInput');
    if (!input) {
      input = document.createElement('input');
      input.id = 'homeUploadInput';
      input.type = 'file';
      input.accept = type === 'album' ? 'image/*' : 'image/*,.txt,.csv';
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
    renderStatus('loading');
    try {
      if (file.type.startsWith('image/')) {
        toast('正在识别运单图片，请稍候...');
        const data = await callOCR(file);
        const stores = Array.isArray(data.stores) ? data.stores.map(item => ({
          code: item.code || '',
          name: item.name || '',
          nav: item.nav || '',
          weight: Number(String(item.weight || '').replace(/[^\d.]/g, '')) || 0,
          matched: item.matched !== false,
          isNew: !!item.isNew
        })).filter(item => item.name) : [];
        if (!stores.length) throw new Error('AI未识别到有效门店');
        parsedOrders = rankOrders(stores);
        renderTags(parsedOrders);
        renderStatus('success', parsedOrders.length);
        const orders = await saveTodayOrders(parsedOrders, {
          source: 'ai-ocr',
          vehicle: data.vehicle || '',
          totalWeight: data.totalWeight || totalWeight(parsedOrders)
        });
        toast(`AI识别完成：${orders.length} 家门店`);
        $('uploadOverlay')?.classList.remove('active');
        setTimeout(window.goToOrderDetail, 700);
        return;
      }

      if (file.type.startsWith('text/') || /\.csv$/i.test(file.name)) {
        $('manualOrderInput').value = await file.text();
        window.parseManualInput();
        return;
      }
      throw new Error('暂不支持该文件类型');
    } catch (e) {
      renderStatus('error', 0, e.message || '解析失败');
      toast(e.message || '运单解析失败', 'warning');
      error(e.message || '解析失败');
    }
  }

  document.addEventListener('DOMContentLoaded', async function () {
    try {
      if (typeof Auth === 'undefined') throw new Error('Auth 未加载');
      if (!Auth.checkAuth()) return;
      await loadBaseStores();
      updateSummary();

      $('manualOrderInput')?.addEventListener('input', function () {
        if ($('charCount')) $('charCount').textContent = String(this.value.length);
      });

      document.addEventListener('click', function (event) {
        const menu = $('homeMenu');
        const button = document.querySelector('.menu-btn');
        if (menu && menu.style.display === 'block' && !menu.contains(event.target) && !button?.contains(event.target)) menu.style.display = 'none';
      });
    } catch (e) {
      console.error(e);
      error(e.message || '首页初始化失败');
    }
  });
})();
