// 天友智配One - 今日运单解析
// OCR原文 -> 提取今日实际门店 -> 与线路基准库匹配 -> 按基准顺序排序。
// 基准库只负责门店身份、固定配送顺序、导航和备注，不代表今天配送全部门店。
import { authRequired } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效或无权限' }, 401);

  try {
    const body = await request.json().catch(() => ({}));
    const text = String(body?.text || '').trim();
    if (!text) return json({ success: false, error: '请输入或先识别运单文字' }, 400);

    const route = normalizeRoute(session.route || body.route);
    if (!route) return json({ success: false, error: '用户未绑定线路' }, 403);
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      return json({ success: false, error: '服务器基准数据库不可用' }, 500);
    }

    const base = await getBaseStores(env, route);
    const parsed = parseDeterministic(text);
    const result = matchTodayStores(parsed.stores, base);

    if (!result.stores.length) {
      return json({ success: false, error: '未识别到有效门店，请检查OCR文字后再解析' }, 422);
    }

    return json({
      success: true,
      data: {
        route,
        date: parsed.date,
        vehicle: parsed.vehicle,
        totalWeight: normalizeWeight(parsed.totalWeight),
        rawOrderCount: parsed.rawOrderCount,
        stores: result.stores,
        storeCount: result.stores.length,
        uniqueStoreCount: result.uniqueStoreCount,
        matchedCount: result.matchedCount,
        newStoreCount: result.newStoreCount,
        reviewCount: result.reviewCount,
        duplicateCount: result.duplicateCount,
        recognizedCount: parsed.stores.length,
        warning: result.reviewCount
          ? `发现 ${result.reviewCount} 家门店需要确认`
          : result.newStoreCount
            ? `发现 ${result.newStoreCount} 家新增门店，请核对`
            : result.duplicateCount
              ? `识别到 ${result.duplicateCount} 条重复门店记录，已合并`
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
  return {
    date: extractDate(source),
    vehicle: extractVehicle(source),
    totalWeight: extractWeight(source),
    rawOrderCount: extractRawOrderCount(source),
    stores: extractArrowStores(routeText)
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
  const start = findRouteStart(source, firstArrow);
  return source.slice(start).trim();
}

function findRouteStart(source, arrowIndex) {
  const before = source.slice(0, arrowIndex);
  const lines = before.split('\n');
  const lastLine = lines.at(-1) || '';
  if (isLikelyStore(cleanStoreName(lastLine))) return source.lastIndexOf(lastLine, arrowIndex);

  const key = /(?:到家主城|江北|渝北|特渠部|天友加盟|天友24h|II类|Ⅱ类)/g;
  let match;
  let last = -1;
  while ((match = key.exec(before))) last = match.index;
  return last >= 0 ? last : arrowIndex;
}

function extractArrowStores(routeText) {
  if (!routeText) return [];
  const stores = [];
  for (const part of routeText.split(/\s*(?:->|-->)\s*/)) {
    const name = cleanStoreName(stripOrderMetadata(part.replace(/\n+/g, '')));
    if (isLikelyStore(name)) stores.push(name);
  }
  // 这里故意不做 unique：OCR原始记录必须保留，重复门店由匹配层合并。
  return stores;
}

function stripOrderMetadata(value) {
  return String(value || '').split(/(?:总数量|总重量|总体积|订单编号|运单编号|车牌号|运输日期|主司机|送货员|额定载重|额定体积)\s*[:：]?/)[0].trim();
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
  try { parsed = typeof parsed === 'string' ? JSON.parse(parsed) : parsed; } catch { parsed = null; }

  if (!Array.isArray(parsed?.stores) || !parsed.stores.length) {
    throw new Error(`未找到${normalizeRoute(route)}独立基准数据库`);
  }
  return parsed.stores;
}

function matchTodayStores(recognized, baseStores) {
  const base = baseStores.map(normalizeBase).filter(Boolean);
  const byName = new Map();
  const byCode = new Map();

  for (const item of base) {
    const key = matchKey(item.name);
    if (key && !byName.has(key)) byName.set(key, item);
    const code = extractBusinessCode(item.name);
    if (code && !byCode.has(code)) byCode.set(code, item);
  }

  const matched = [];
  const review = [];
  const news = [];
  const used = new Set();
  const canonicalByBaseIndex = new Map();
  let duplicateCount = 0;

  for (const raw of recognized) {
    const direct = findDirectMatch(raw, base, byName, byCode);

    // 同一基准门店再次出现在OCR中：保留原始记录计数，但最终门店只保留一份。
    if (direct && used.has(direct.item.index)) {
      const canonical = canonicalByBaseIndex.get(direct.item.index);
      if (canonical) {
        canonical.duplicateCount = Number(canonical.duplicateCount || 0) + 1;
        canonical.rawNames = Array.isArray(canonical.rawNames) ? canonical.rawNames : [canonical.name];
        if (!canonical.rawNames.includes(raw)) canonical.rawNames.push(raw);
        duplicateCount += 1;
        continue;
      }
    }

    const hit = findMatch(raw, base, byName, byCode, used);
    if (hit.type === 'match') {
      used.add(hit.item.index);
      const item = toMatched(hit.item, hit.mode, hit.score, raw);
      matched.push(item);
      canonicalByBaseIndex.set(hit.item.index, item);
    } else if (hit.type === 'review') {
      review.push({
        code: '',
        name: raw,
        nav: '',
        note: '',
        isNew: false,
        matched: false,
        needsReview: true,
        candidate: hit.item.name,
        candidates: hit.alternatives.map(item => item.name),
        matchScore: Number(hit.score.toFixed(3)),
        rawNames: [raw]
      });
    } else {
      news.push({
        code: '',
        name: raw,
        nav: '',
        note: '',
        isNew: true,
        matched: false,
        rawNames: [raw]
      });
    }
  }

  matched.sort((a, b) => a._i - b._i);
  matched.forEach((item, i) => { item.code = String(i + 1).padStart(2, '0'); });
  review.forEach((item, i) => { item.code = `R${String(i + 1).padStart(2, '0')}`; });
  news.forEach((item, i) => { item.code = `N${String(i + 1).padStart(2, '0')}`; });

  const stores = matched.concat(review, news).map(({ _i, ...item }) => item);
  return {
    stores,
    matchedCount: matched.length,
    reviewCount: review.length,
    newStoreCount: news.length,
    duplicateCount,
    uniqueStoreCount: stores.length
  };
}

function findDirectMatch(raw, base, byName, byCode) {
  const key = matchKey(raw);
  if (!key) return null;
  const exact = byName.get(key);
  if (exact) return { type: 'match', item: exact, mode: 'exact', score: 1 };

  const businessCode = extractBusinessCode(raw);
  if (businessCode) {
    const coded = byCode.get(businessCode);
    if (coded) return { type: 'match', item: coded, mode: 'businessCode', score: 1 };
  }
  return null;
}

function findMatch(raw, base, byName, byCode, used) {
  const direct = findDirectMatch(raw, base, byName, byCode);
  if (direct && !used.has(direct.item.index)) return direct;

  const scored = base
    .filter(item => !used.has(item.index))
    .map(item => ({ item, score: storeSimilarity(raw, item.name) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < 0.58) return { type: 'new', score: best?.score || 0 };

  const second = scored[1];
  const margin = second ? best.score - second.score : best.score;
  const confident = best.score >= 0.88
    || (best.score >= 0.82 && margin >= 0.08)
    || (best.score >= 0.76 && margin >= 0.14 && matchKey(best.item.name).length >= 12);
  if (confident) return { type: 'match', item: best.item, mode: 'similarity', score: best.score };
  if (best.score >= 0.64) return { type: 'review', item: best.item, score: best.score, alternatives: scored.slice(0, 3).map(entry => entry.item) };
  return { type: 'new', score: best.score };
}

function storeSimilarity(a, b) {
  const ak = matchKey(a), bk = matchKey(b);
  if (!ak || !bk) return 0;
  if (ak === bk) return 1;
  const codeA = extractBusinessCode(a), codeB = extractBusinessCode(b);
  if (codeA && codeA === codeB) return 1;
  const tokenScore = tokenOverlap(stableStoreKey(a), stableStoreKey(b));
  const charScore = characterNgramSimilarity(ak, bk);
  const editScore = normalizedEditSimilarity(ak, bk);
  const containment = ak.includes(bk) || bk.includes(ak) ? Math.min(ak.length, bk.length) / Math.max(ak.length, bk.length) : 0;
  return Math.min(1, editScore * 0.34 + charScore * 0.32 + tokenScore * 0.24 + containment * 0.10);
}

function stableStoreKey(value) {
  return matchKey(value)
    .replace(/^(?:渝北|江北|特渠部|天友加盟|天友24h)/, '')
    .replace(/谊品鲜/g, '谊品生鲜');
}
function tokenOverlap(a, b) {
  const ta = meaningfulTokens(a), tb = meaningfulTokens(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const token of ta) if (tb.has(token)) common++;
  return common / Math.max(ta.size, tb.size);
}
function meaningfulTokens(value) {
  const set = new Set();
  for (const token of matchKey(value).match(/[a-z]+|\d+|[\u4e00-\u9fff]+/g) || []) {
    if (token.length >= 2 || /\d/.test(token) || /[a-z]/i.test(token)) set.add(token);
  }
  return set;
}
function characterNgramSimilarity(a, b, n = 2) {
  const aa = ngramSet(matchKey(a), n), bb = ngramSet(matchKey(b), n);
  if (!aa.size || !bb.size) return 0;
  let common = 0;
  for (const value of aa) if (bb.has(value)) common++;
  return (2 * common) / (aa.size + bb.size);
}
function ngramSet(text, n) {
  const set = new Set();
  if (!text) return set;
  if (text.length <= n) return set.add(text);
  for (let i = 0; i <= text.length - n; i++) set.add(text.slice(i, i + n));
  return set;
}
function normalizedEditSimilarity(a, b) {
  const x = matchKey(a), y = matchKey(b);
  if (!x || !y) return 0;
  return 1 - editDistance(x, y) / Math.max(x.length, y.length);
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
function toMatched(item, mode, score, raw) {
  return {
    code: item.code,
    name: item.name,
    nav: item.nav,
    note: item.note,
    isNew: false,
    matched: true,
    matchType: mode,
    matchScore: Number(score.toFixed(3)),
    rawNames: [raw],
    _i: item.index
  };
}
function normalizeBase(store, index) {
  if (typeof store === 'string') {
    const name = cleanStoreName(store);
    return name ? { name, code: String(index + 1).padStart(2, '0'), nav: '', note: '', index } : null;
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
  const match = String(value || '').toUpperCase().match(/(?:^|[^A-Z0-9])(JM\d{4,6}|Q\d{3,5}|A\d{4,6})(?:[^A-Z0-9]|$)/);
  return match ? match[1] : '';
}

function matchKey(value) {
  let text = cleanStoreName(value)
    .replace(/Ⅱ/g, 'II').replace(/Ⅲ/g, 'III').replace(/Ⅳ/g, 'IV').replace(/Ⅴ/g, 'V')
    .replace(/Ⅵ/g, 'VI').replace(/Ⅶ/g, 'VII').replace(/Ⅷ/g, 'VIII').replace(/Ⅸ/g, 'IX').replace(/Ⅹ/g, 'X')
    // OCR订单常把年份/临时标记放进括号，这些属于同一门店身份，不参与匹配。
    .replace(/[（(]\s*(?:临时|20\d{2})\s*[）)]/g, '')
    .replace(/江北亿达鲜半华府店/g, '江北亿达鲜半山华府店')
    .replace(/谊品鲜/g, '谊品生鲜');

  // 只对明确的“到家主城-江北区加州”别名做双向归一，避免误伤其他客服/客户中心。
  if (text.includes('到家主城') && text.includes('江北区加州')) {
    text = text.replace(/客服中心|客户中心/g, '服务中心');
  }

  return text
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
function isLikelyStore(value) {
  const text = String(value || '').trim();
  if (!text || text.length < 3 || text.length > 160) return false;
  if (/总重量|总数量|总体积|订单编号|运单编号|车牌|车辆|运输日期|日期|司机|送货员|主司机|承运订单|额定装载|额定载重|额定体积|总计|合计|单价|金额/.test(text)) return false;
  return /店|公司|经销商|加盟|中心|超市|便利|生鲜|食品|贸易|商行|门市|乳业|大厦|药房|餐饮|酒店|委员会|管理中心|服务中心|供应链|公园|食堂/.test(text);
}
function extractDate(value) {
  const match = String(value || '').match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/);
  return match ? normalizeDate(match[1]) : '';
}
function extractVehicle(value) {
  const match = String(value || '').match(/(?:车牌号|车牌|车辆)\s*[:：]?\s*([\u4e00-\u9fa5][A-Z0-9]{5,7})/i);
  return match ? normalizeVehicle(match[1]) : '';
}
function extractWeight(value) {
  const source = String(value || '').replace(/\s+/g, ' ');
  const match = source.match(/总\s*重\s*量\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  if (match) return `${match[1]}${match[2] || ''}`.trim();
  const fallback = source.match(/(?:总重|重量)\s*[:：]?\s*([\d]+(?:\.\d+)?)\s*(kg|KG|千克|公斤|吨|t)?/i);
  return fallback ? `${fallback[1]}${fallback[2] || ''}`.trim() : '';
}
function extractRawOrderCount(value) {
  const match = String(value || '').match(/总数量\s*[:：]?\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}
function normalizeWeight(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim().replace(/,/g, '');
  const match = text.match(/[\d]+(?:\.\d+)?/);
  if (!match) return '';
  const number = Number(match[0]);
  if (!Number.isFinite(number) || number < 0) return '';
  const hasKg = /kg|千克|公斤/i.test(text);
  const hasTon = /吨|\bt\b/i.test(text);
  const tons = hasTon ? number : hasKg ? number / 1000 : number >= 1000 ? number / 1000 : number;
  if (!Number.isFinite(tons)) return '';
  const precise = Math.round((tons + Number.EPSILON) * 1000000) / 1000000;
  return `${precise.toFixed(6).replace(/0+$/, '').replace(/\.$/, '') || '0'}t`;
}
function normalizeVehicle(value) { return String(value || '').replace(/[\s>]+$/, '').trim(); }
function normalizeDate(value) {
  const text = String(value || '').replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-');
  const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : text;
}
function normalizeRoute(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : text;
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' } });
}
