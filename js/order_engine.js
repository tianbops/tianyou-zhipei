/* 天友智配One - 统一运单处理引擎
 * 负责：清洗、去重、基准匹配、排序、新门店后置、重量统计、标准化输出。
 * 页面只负责输入/展示；图片 OCR、文字解析、手工输入均可调用本引擎。
 */
(function (global) {
  'use strict';

  const DEFAULT_STATUS = '待配送';

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function normalizeName(value) {
    return text(value)
      .replace(/[\u3000]/g, ' ')
      .replace(/^[\s\d、.．)）_\-]+/, '')
      .replace(/[，,。；;：:]$/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function nameOf(store) {
    return normalizeName(
      store && (store.name || store.storeName || store.shopName || store['门店名称'])
    );
  }

  function codeOf(store, fallbackIndex) {
    const value = text(store && (store.code || store.storeCode || store.id));
    if (/^\d+$/.test(value)) return String(Number(value)).padStart(2, '0');
    return String(fallbackIndex + 1).padStart(2, '0');
  }

  function number(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const match = text(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : 0;
  }

  function buildIndex(baseStores) {
    const byName = new Map();
    const byCode = new Map();
    (Array.isArray(baseStores) ? baseStores : []).forEach((store, index) => {
      const name = nameOf(store);
      const code = codeOf(store, index);
      if (name) byName.set(name, { store, index, code });
      byCode.set(code, { store, index, code });
    });
    return { byName, byCode };
  }

  function matchStore(item, index) {
    const name = nameOf(item);
    return { name, code: codeOf(item, index) };
  }

  function process(input, options) {
    const opts = options || {};
    const baseStores = Array.isArray(opts.baseStores) ? opts.baseStores : [];
    const route = text(opts.route);
    const date = text(opts.date) || new Date().toISOString().slice(0, 10);
    const defaultVehicle = text(opts.vehicle);
    const index = buildIndex(baseStores);
    const seen = new Map();
    const source = Array.isArray(input) ? input : [];

    source.forEach((raw, sourceIndex) => {
      const candidate = typeof raw === 'string' ? { name: raw } : (raw || {});
      const match = matchStore(candidate, sourceIndex);
      if (!match.name) return;
      const baseByName = index.byName.get(match.name);
      const baseByCode = index.byCode.get(match.code);
      const base = baseByName || baseByCode || null;
      const finalName = base ? nameOf(base.store) : match.name;
      const key = base
        ? `base:${base.index}`
        : `new:${normalizeName(finalName).toLowerCase()}`;

      if (seen.has(key)) {
        const old = seen.get(key);
        const extraWeight = number(candidate.weight || candidate.totalWeight);
        if (extraWeight && !old._weightFromExplicit) old.weight += extraWeight;
        if (!old.nav && candidate.nav) old.nav = text(candidate.nav);
        return;
      }

      const explicitWeight = number(candidate.weight || candidate.totalWeight);
      const order = {
        code: base ? base.code : match.code,
        name: finalName,
        nav: text(candidate.nav || (base && base.store && base.store.nav)),
        weight: explicitWeight,
        matched: !!base,
        isNew: !base,
        status: text(candidate.status) || DEFAULT_STATUS,
        date,
        route,
        vehicle: text(candidate.vehicle || defaultVehicle),
        sourceIndex,
        _baseIndex: base ? base.index : Number.MAX_SAFE_INTEGER,
        _weightFromExplicit: explicitWeight > 0
      };
      seen.set(key, order);
    });

    const orders = Array.from(seen.values())
      .sort((a, b) => a._baseIndex - b._baseIndex || a.sourceIndex - b.sourceIndex)
      .map((item, position) => {
        const clean = { ...item };
        delete clean._baseIndex;
        delete clean._weightFromExplicit;
        delete clean.sourceIndex;
        clean.code = clean.matched ? clean.code : String(position + 1).padStart(2, '0');
        return clean;
      });

    return {
      orders,
      count: orders.length,
      matchedCount: orders.filter(item => item.matched).length,
      newCount: orders.filter(item => item.isNew).length,
      totalWeight: orders.reduce((sum, item) => sum + number(item.weight), 0),
      route,
      date,
      vehicle: defaultVehicle
    };
  }

  function parseText(rawText, options) {
    const rows = [];
    String(rawText == null ? '' : rawText).split(/\r?\n/).forEach(line => {
      let value = normalizeName(line);
      if (!value) return;
      if (/^(总重量|合计|总计|车牌|车辆|日期|线路|配送日期)/.test(value)) return;

      const weightMatch = value.match(/(\d+(?:\.\d+)?)\s*(kg|KG|千克|公斤)/i);
      const codeMatch = value.match(/^(\d{1,3})[、.．)）\s\-]+(.+)$/);
      const code = codeMatch ? String(Number(codeMatch[1])).padStart(2, '0') : '';
      value = codeMatch ? codeMatch[2] : value;
      value = value.replace(/\d+(?:\.\d+)?\s*(kg|KG|千克|公斤)/ig, '').trim();
      value = normalizeName(value);
      if (!value) return;
      rows.push({ code, name: value, weight: weightMatch ? Number(weightMatch[1]) : 0 });
    });
    return process(rows, options);
  }

  function normalizeAI(data, options) {
    const payload = data || {};
    const rows = Array.isArray(payload.stores) ? payload.stores : [];
    const result = process(rows, {
      ...(options || {}),
      vehicle: text(payload.vehicle || (options && options.vehicle))
    });
    if (payload.totalWeight !== undefined && payload.totalWeight !== '') {
      result.totalWeight = number(payload.totalWeight);
    }
    return result;
  }

  function serialize(result, meta) {
    const data = result || { orders: [], totalWeight: 0 };
    const m = meta || {};
    return {
      date: text(m.date) || data.date || new Date().toISOString().slice(0, 10),
      route: text(m.route) || data.route || '',
      vehicle: text(m.vehicle) || data.vehicle || '',
      orders: Array.isArray(data.orders) ? data.orders : [],
      stores: Array.isArray(data.orders) ? data.orders.length : 0,
      totalWeight: number(m.totalWeight !== undefined ? m.totalWeight : data.totalWeight),
      source: text(m.source) || 'unknown'
    };
  }

  global.OrderEngine = Object.freeze({
    normalizeName,
    number,
    process,
    parseText,
    normalizeAI,
    serialize
  });
})(window);
