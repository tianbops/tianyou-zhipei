// 天友智配One - 今日运单解析
// OCR原文 -> 提取今日实际门店 -> 与当前线路基准库匹配 -> 按基准顺序排序。
// 注意：基准库只用于门店身份和固定配送顺序，不代表今天一定配送全部门店。
import { authRequired } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效或无权限' }, 401);

  try {
    const body = await request.json().catch(() => ({}));
    const text = String(body?.text || '').trim();
    if (!text) return json({ success: false, error: '请输入或先识别运单文字' }, 400);

    const route = normalizeRoute(session.route);
    if (!route) return json({ success: false, error: '用户未绑定线路' }, 403);
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      return json({ success: false, error: '服务器基准数据库不可用' }, 500);
    }

    const base = await getBaseStores(env, route);
    const parsed = parseDeterministic(text);
    const result = matchAndSortTodayStores(parsed.stores, base);

    if (!result.stores.length) {
      return json({ success: false, error: '未识别到有效门店，请检查OCR文字后再解析' }, 422);
    }

    const totalWeight = normalizeWeight(parsed.totalWeight);
    const meta = {
      route,
      date: parsed.date || extractDate(text),
      vehicle: parsed.vehicle || extractVehicle(text),
      totalWeight,
      rawOrderCount: parsed.rawOrderCount
    };

    return json({
      success: true,
      data: {
        ...meta,
        stores: result.stores,
        storeCount: result.stores.length,
        matchedCount: result.matchedCount,
        newStoreCount: result.newStoreCount,
        reviewCount: result.reviewCount,
        recognizedCount: parsed.stores.length,
        warning: result.reviewCount
          ? `发现 ${result.reviewCount} 家门店需要确认`
          : result.newStoreCount
            ? `发现 ${result.newStoreCount} 家新增门店，请核对`
            : ''
      }
    });
  } catch (error) {
    console.error('parse api error', error);
    return json({ success: false, error: error?.message || '运单文字解析失败' }, 503);
  }
}

function parseDeterministic(text) {
  const source = normalizeOcrText(text);
  const routeText = extractRouteText(source);
  const stores = extractArrowStores(routeText);

  return {
    date: extractDate(source),
    vehicle: extractVehicle(source),
    totalWeight: extractWeight(source),
    rawOrderCount: extractRawOrderCount(source),
    stores
  };
}

function normalizeOcrText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[→＞》➜➤⇒]/g, '->')
    .replace(/[﹣－—–]/g, '-')
    .replace(/[\u00a0\u200b\ufeff]/g, ' ')
    .trim();
}

function extractRouteText(source) {
  const firstArrow = source.indexOf('->');
  if (firstArrow < 0) return '';

  // 从第一家实际门店附近开始，一直保留到文本末尾。
  // 不再使用“总数量/总重量”截断，因为这些字段位于今日门店链之前。
  return source.slice(firstArrow > 0 ? findRouteStart(source, firstArrow) : firstArrow).trim();
}

function findRouteStart(source, arrowIndex) {
  const before = source.slice(0, arrowIndex);
  const lines = before.split('\n');
  const lastLine = lines[lines.length - 1] || '';
  const candidate = cleanStoreName(lastLine);
  if (isLikelyStore(candidate)) return source.lastIndexOf(lastLine, arrowIndex);

  // OCR可能把第一家门店和上一行字段粘在一起，向前寻找常见门店关键词。
  const key = /(?:到家主城|江北|渝北|特渠部|天友加盟|天友24h|II类|Ⅱ类)/g;
  let match;
  let last = -1;
  while ((match = key.exec(before))) last = match.index;
  return last >= 0 ? last : arrowIndex;
}

function extractArrowStores(routeText) {
  if (!routeText) return [];

  const parts = routeText.split(/\s*(?:->|-->)\s*/);
  const stores = [];

  for (const part of parts) {
    // 箭头前后的换行只是OCR排版，不是门店分隔符。
    const name = cleanStoreName(part.replace(/\n+/g, ''));
    if (isLikelyStore(name)) stores.push(name);
  }

  return unique(stores);
}

async function getBaseStores(env, route) {
  const key = `route:${normalizeRoute(route)}:base`;
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('线路基准数据库读取失败');

  const data = await response.json().catch(() => ({}));
  let parsed = data?.result;
  try { parsed = typeof parsed === 'string' ? JSON.parse(parsed) : parsed; } catch (_) { parsed = null; }

  if (!Array.isArray(parsed?.stores) || !parsed.stores.length) {
    throw new Error(`未找到${normalizeRoute(route)}独立基准数据库`);
  }
  return parsed.stores;
}

function matchAndSortTodayStores(recognized, baseStores) {
  const base = baseStores.map(normalizeBase).filter(Boolean);
  const byName = new Map(base.map(item => [matchKey(item.name), item]));
  const byCode = new Map();
  for (const item of base) {
    const code = extractBusinessCode(item.name);
    if (code) byCode.set(code, item);
  }

  const matched = [];
  const review = [];
  const news = [];
  const used = new Set();
  const seenReview = new Set();
  const seenNew = new Set();

  for (const raw of unique(recognized)) {
    const hit = findMatch(raw, base, byName, byCode, used);

    if (hit.type === 'match') {
      used.add(hit.item.index);
      matched.push(toMatched(hit.item, hit.mode, hit.score));
      continue;
    }

    if (hit.type === 'review') {
      const key = matchKey(raw);
      if (!seenReview.has(key)) {
        seenReview.add(key);
        review.push({
          code: '',
          name: raw,
          nav: '',
          note: '',
          isNew: false,
          matched: false,
          needsReview: true,
          candidate: hit.item.name,
          candidates: hit.alternatives.map(x => x.name),
          matchScore: Number(hit.score.toFixed(3))
        });
      }
      continue;
    }

    const key = matchKey(raw);
    if (!seenNew.has(key)) {
      seenNew.add(key);
      news.push({
        code: '',
        name: raw,
        nav: '',
        note: '',
        isNew: true,
        matched: false
      });
    }
  }

  // 只有OCR明确出现的门店才进入今日运单。
  // 这里绝不把未配送的基准门店补进来。
  matched.sort((a, b) => a._i - b._i);

  matched.forEach((item, index) => {
    item.code = String(index + 1).padStart(2, '0');
  });
  review.forEach((item, index) => {
    item.code = `R${String(index + 1).padStart(2, '0')}`;
  });
  news.forEach((item, index) => {
    item.code = `N${String(index + 1).padStart(2, '0')}`;
  });

  return {
    stores: matched.concat(review, news).map(item => {
      const out = { ...item };
      delete out._i;
      return out;
    }),
    matchedCount: matched.length,
    reviewCount: review.length,
    newStoreCount: news.length
  };
}

function findMatch(raw, base, byName, byCode, used) {
  const key = matchKey(raw);
  if (!key) return { type: 'new', score: 0 };

  const exact = byName.get(key);
  if (exact) {
    if (used.has(exact.index)) return { type: 'new', score: 0 };
    return { type: 'match', item: exact, mode: 'exact', score: 1 };
  }

  const code = extractBusinessCode(raw);
  if (code) {
    const coded = byCode.get(code);
    if (coded && !used.has(coded.index)) {
      return { type: 'match', item: coded, mode: 'businessCode', score: 1 };
    }
  }

  const scored = base
    .filter(item => !used.has(item.index))
    .map(item => ({ item, score: storeSimilarity(raw, item.name) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 0.58) return { type: 'new', score: best?.score || 0 };

  const second = scored[1];
  const margin = second ? best.score - second.score : best.score;

  // 有业务编号但编号本身无法匹配时，不因为高相似度直接冒险认定。
  const confidence = best.score >= 0.88 ||
    (best.score >= 0.82 && margin >= 0.08) ||
    (best.score >= 0.76 && margin >= 0.14 && matchKey(best.item.name).length >= 12);

  if (confidence) {
    return { type: 'match', item: best.item, mode: 'similarity', score: best.score };
  }

  if (best.score >= 0.64) {
    return {
      type: 'review',
      item: best.item,
      score: best.score,
      alternatives: scored.slice(0, 3).map(x => x.item)
    };
  }

  return { type: 'new', score: best.score };
}

function storeSimilarity(a, b) {
  const ak = matchKey(a);
  const bk = matchKey(b);
  if (!ak || !bk) return 0;
  if (ak === bk) return 1;

  const codeA = extractBusinessCode(a);
  const codeB = extractBusinessCode(b);
  if (codeA && codeA === codeB) return 1;

  const stableA = stableStoreKey(a);
  const stableB = stableStoreKey(b);
  const tokenScore = tokenOverlap(stableA, stableB);
  const charScore = characterNgramSimilarity(ak, bk);
  const editScore = normalizedEditSimilarity(ak, bk);
  const containment = ak.includes(bk) || bk.includes(ak)
    ? Math.min(ak.length, bk.length) / Math.max(ak.length, bk.length)
    : 0;

  let score = editScore * 0.34 + charScore * 0.32 + tokenScore * 0.24 + containment * 0.10;

  // 常见OCR差异：谊品鲜/谊品生鲜、Ⅱ/II、括号和空格已经在matchKey中归一化。
  score = Math.min(1, score);
  return score;
}

function stableStoreKey(value) {
  return matchKey(value)
    .replace(/^渝北|^江北|^特渠部|^天友加盟|^iic类天友生活|^ii类天友生活|^天友24h/, '')
    .replace(/谊品鲜/g, '谊品生鲜');
}

function tokenOverlap(a, b) {
  const ta = meaningfulTokens(a);
  const tb = meaningfulTokens(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const token of ta) if (tb.has(token)) common++;
  return common / Math.max(ta.size, tb.size);
}

function meaningfulTokens(value) {
  const text = matchKey(value);
  const set = new Set();
  for (const token of text.match(/[a-z]+|\d+|[\u4e00-\u9fff]+/g) || []) {
    if (token.length >= 2 || /\d/.test(token) || /[a-z]/i.test(token)) set.add(token);
  }
  return set;
}

function characterNgramSimilarity(a, b, n = 2) {
  const aa = matchKey(a);
  const bb = matchKey(b);
  if (!aa || !bb) return 0;
  const sa = ngramSet(aa, n);
  const sb = ngramSet(bb, n);
  if (!sa.size || !sb.size) return 0;
  let common = 0;
  for (const value of sa) if (sb.has(value)) common++;
  return (2 * common) / (sa.size + sb.size);
}

function ngramSet(text, n) {
  const set = new Set();
  if (text.length <= n) {
    if (text) set.add(text);
    return set;
  }
  for (let i = 0; i <= text.length - n; i++) set.add(text.slice(i, i + n));
  return set;
}

function normalizedEditSimilarity(a, b) {
  const x = matchKey(a);
  const y = matchKey(b);
  if (!x || !y) return 0;
  const distance = editDistance(x, y);
  return 1 - distance / Math.max(x.length, y.length);
}

function editDistance(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[b.length];
}

function toMatched(item, mode, score) {
  return {
    code: item.code,
    name: item.name,
    nav: item.nav || '',
    note: item.note || '',
    isNew: false,
    matched: true,
    matchType: mode,
    matchScore: Number(score.toFixed(3)),
    _i: item.index
  };
}

function normalizeBase(store, index) {
  if (typeof store === 'string') {
    return { name: cleanStoreName(store), code: String(index + 1).padStart(2, '0'), nav: '', note: '', index };
  }
  if (!store) return null;

  const name = cleanStoreName(store.name || store.storeName || store.title || store.customerName || store['门店名称'] || '');
  if (!name) return null;

  return {
    name,
    code: String(store.code || index + 1).padStart(2, '0'),
    nav: store.nav || store.navigation || store.url || store['导航'] || '',
    note: store.note || store['备注'] || '',
    index
  };
}

function extractBusinessCode(value) {
  const m = String(value || '').toUpperCase().match(/(?:^|[^A-Z0-9])(JM\d{4,6}|Q\d{3,5}|A\d{4,6})(?:[^A-Z0-9]|$)/);
  return m ? m[1] : '';
}

function matchKey(value) {
  return cleanStoreName(value)
    .replace(/Ⅱ/g, 'II')
    .replace(/Ⅲ/g, 'III')
    .replace(/Ⅳ/g, 'IV')
    .replace(/Ⅴ/g, 'V')
    .replace(/Ⅵ/g, 'VI')
    .replace(/Ⅶ/g, 'VII')
    .replace(/Ⅷ/g, 'VIII')
    .replace(/Ⅸ/g, 'IX')
    .replace(/Ⅹ/g, 'X')
    .replace(/（2026）$/g, '')
    .replace(/\(2026\)$/g, '')
    .replace(/谊品鲜/g, '谊品生鲜')
    .replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g, '')
    .toLowerCase();
}

function cleanStoreName(value) {
  return String(value || '')
    .replace(/^[\s\d]+[、.．)）-]+/, '')
    .replace(/^承运订单[：:\s]*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values) {
  const seen = new Set();
  return values.filter(value => {
    const key = matchKey(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isLikelyStore(value) {
  const text = String(value || '').trim();
  if (!text || text.length < 3 || text.length > 160) return false;
  if (/总重量|总数量|总体积|订单编号|运单编号|车牌|车辆|运输日期|日期|司机|送货员|主司机|承运订单|额定装载|额定载重|额定体积|总计|合计|单价|金额/.test(text)) return false;
  return /店|公司|经销商|加盟|中心|超市|便利|生鲜|食品|贸易|商行|门市|乳业|大厦|药房|餐饮|酒店|委员会|管理中心|服务中心|供应链|公园|食堂/.test(text);
}

function extractDate(value) {
  const m = String(value || '').match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  return m ? normalizeDate(m[1]) : '';
}

function extractVehicle(value) {
  const m = String(value || '').match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  return m ? normalizeVehicle(m[1]) : '';
}

function extractWeight(value) {
  const m = String(value || '').match(/总重量\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  return m ? `${m[1]}${m[2] || 'kg'}` : '';
}

function extractRawOrderCount(value) {
  const m = String(value || '').match(/总数量\s*[:：]?\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

function normalizeWeight(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim().replace(/,/g, '');
  const m = text.match(/[\d]+(?:\.\d+)?/);
  if (!m) return '';
  const n = Number(m[0]);
  if (!Number.isFinite(n)) return '';
  const tons = /吨|\bt\b/i.test(text) ? n : n / 1000;
  return `${(Math.round((tons + Number.EPSILON) * 10) / 10).toFixed(1)}t`;
}

function normalizeVehicle(value) {
  return String(value || '').replace(/[\s>]+$/, '').trim();
}

function normalizeDate(value) {
  const text = String(value || '').replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-');
  const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  return match
    ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`
    : text;
}

function normalizeRoute(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : text;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store'
    }
  });
}
