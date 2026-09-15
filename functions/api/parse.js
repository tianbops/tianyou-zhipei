// 天友智配One - 运单文字解析
// 核心流程：OCR原文 -> 提取门店 -> 基准库匹配 -> 按基准配送顺序排序。
// 对常见的“门店 -> 门店 -> 门店”运单格式，优先使用确定性解析，避免再次调用AI造成漏店、乱序和额外等待。
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
    let parsed = parseDeterministic(text);

    // 常见运单有明确箭头链时，不再调用AI解析，降低延迟并避免AI漏店。
    if (parsed.stores.length < 2 && env.AI && typeof env.AI.run === 'function') {
      parsed = await parseOrderText(env.AI, text);
    }

    const result = normalizeAndSort(parsed.stores, base);
    if (!result.stores.length) {
      return json({ success: false, error: '未识别到有效门店，请检查OCR文字后再解析' }, 422);
    }

    const meta = {
      route,
      date: normalizeDate(parsed.date) || normalizeDate(extractDate(text)),
      vehicle: normalizeVehicle(parsed.vehicle) || extractVehicle(text),
      totalWeight: normalizeWeight(parsed.totalWeight) || extractWeight(text),
      rawOrderCount: Number(parsed.rawOrderCount) || extractRawOrderCount(text)
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
        recognizedCount: result.recognizedCount,
        warning: result.reviewCount
          ? `发现 ${result.reviewCount} 家疑似门店需要确认`
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
  const source = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const normalized = source.replace(/[→＞》➜➤⇒]/g, '->');
  const date = extractDate(normalized);
  const vehicle = extractVehicle(normalized);
  const totalWeight = extractWeight(normalized);
  const rawOrderCount = extractRawOrderCount(normalized);

  if (!/->/.test(normalized)) {
    return { date, vehicle, totalWeight, rawOrderCount, stores: [] };
  }

  let chain = normalized;
  const marker = chain.match(/承运订单\s*[：:]?/);
  if (marker) chain = chain.slice((marker.index ?? 0) + marker[0].length);

  chain = chain.split(/(?:总数量|总重量|额定载重|额定装载|额定体积|订单编号|运单编号)\s*[：:]?/)[0];

  const chunks = chain.split(/\s*(?:->|-->)\s*/);
  const stores = unique(chunks.map(cleanStoreName).filter(isLikelyStore));
  return { date, vehicle, totalWeight, rawOrderCount, stores };
}

async function parseOrderText(AI, text) {
  const prompt = `你是“天友智配One”运单文字解析器。用户已经检查过OCR原文，现在只从这段文字中提取真实配送门店，不要进行基准库匹配。

严格规则：
1. “承运订单”之后的客户配送链最重要。
2. ->、→、＞、》、➜、➤、⇒都是门店之间的分隔符。
3. 如果公司名称因OCR换行被拆成多行，要合并成一家门店；换行不是门店边界。
4. 必须从第一个客户读取到最后一个客户，不能只取前几家。
5. “总数量207”绝对不是门店数量。rawOrderCount只能记录207，不得把207变成门店。
6. 忽略额定载重、额定体积、主司机、送货员、订单编号、金额等非门店信息。
7. 保留公司全称、区域、括号内容以及JM/Q/A等有意义的门店标识。
8. 不要猜测不存在的门店。
9. stores只包含门店名称字符串，不包含序号。

只返回JSON，不要Markdown：
{"date":"2026-08-22","vehicle":"渝DK7692","totalWeight":"1.806213t","rawOrderCount":207,"stores":["门店A","门店B"]}

OCR文字：
${text}`;

  try {
    const r = await AI.run('@cf/google/gemma-4-26b-a4b-it', {
      messages: [{ role: 'user', content: prompt }],
      max_completion_tokens: 4096,
      temperature: 0,
      chat_template_kwargs: { thinking: false }
    });
    return parseAI(r, text);
  } catch (e) {
    console.warn('AI parse failed, using deterministic fallback:', e?.message || e);
    return parseDeterministic(text);
  }
}

function parseAI(r, text) {
  const s = extractAIText(r).trim();
  const candidates = [s];
  const a = s.indexOf('{');
  const z = s.lastIndexOf('}');
  if (a >= 0 && z > a) candidates.push(s.slice(a, z + 1));

  for (const x of candidates) {
    if (!x) continue;
    try {
      const d = JSON.parse(x);
      if (d && Array.isArray(d.stores)) {
        return {
          date: d.date || '',
          vehicle: d.vehicle || '',
          totalWeight: d.totalWeight || '',
          rawOrderCount: d.rawOrderCount || 0,
          stores: expandStoreList(d.stores)
        };
      }
    } catch (_) {}
  }
  return parseDeterministic(text);
}

function extractAIText(r) {
  if (typeof r === 'string') return r;
  if (!r || typeof r !== 'object') return '';
  return String(r.response ?? r.text ?? r.result?.response ?? r.result?.text ?? '');
}

function expandStoreList(items) {
  const out = [];
  for (const item of items || []) {
    const value = typeof item === 'string' ? item : item?.name || item?.storeName || item?.customerName || '';
    String(value).replace(/[→＞》➜➤⇒]/g, '->').split(/\s*(?:->|-->)\s*/).forEach(part => {
      const name = cleanStoreName(part);
      if (isLikelyStore(name)) out.push(name);
    });
  }
  return unique(out);
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

function normalizeAndSort(recognized, baseStores) {
  const src = unique((recognized || []).map(cleanStoreName).filter(Boolean));
  const base = (baseStores || []).map(normalizeBase).filter(Boolean);
  const byName = new Map();
  const byBusinessCode = new Map();

  for (const item of base) {
    byName.set(matchKey(item.name), item);
    const businessCode = extractBusinessCode(item.name);
    if (businessCode) byBusinessCode.set(businessCode, item);
  }

  const matched = [];
  const news = [];
  const review = [];
  const used = new Set();

  for (const raw of src) {
    const rk = matchKey(raw);
    const rawBusinessCode = extractBusinessCode(raw);
    let exact = byName.get(rk);

    // Q/JM/A等业务编号比完整名称更稳定，优先作为第二匹配条件。
    if (!exact && rawBusinessCode) exact = byBusinessCode.get(rawBusinessCode);

    if (exact && !used.has(exact.index)) {
      used.add(exact.index);
      matched.push(toMatched(exact, false, 1));
      continue;
    }

    let best = null;
    let bestScore = 0;
    for (const item of base) {
      if (used.has(item.index)) continue;
      const score = similarity(rk, matchKey(item.name));
      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    if (best && bestScore >= 0.88) {
      used.add(best.index);
      matched.push(toMatched(best, true, bestScore));
      continue;
    }

    if (best && bestScore >= 0.72 && Math.min(rk.length, matchKey(best.name).length) >= 6) {
      review.push({ code: '', name: raw, nav: '', isNew: false, matched: false, needsReview: true, candidate: best.name, matchScore: Number(bestScore.toFixed(3)) });
      continue;
    }

    if (isLikelyStore(raw)) news.push({ code: '', name: raw, nav: '', isNew: true, matched: false });
  }

  // 最终顺序：基准门店 -> 疑似门店 -> 新增门店。
  matched.sort((a, b) => a._i - b._i);
  review.forEach((item, index) => { item.code = `R${String(index + 1).padStart(2, '0')}`; });
  news.forEach((item, index) => { item.code = `N${String(index + 1).padStart(2, '0')}`; });

  return {
    stores: matched.concat(review, news).map(item => {
      const result = { ...item };
      delete result._i;
      return result;
    }),
    recognizedCount: src.length,
    matchedCount: matched.length,
    newStoreCount: news.length,
    reviewCount: review.length
  };
}

function toMatched(hit, assisted, score) {
  return {
    code: hit.code,
    name: hit.name,
    nav: hit.nav || '',
    note: hit.note || '',
    isNew: false,
    matched: true,
    matchType: assisted ? 'similarity' : 'exact',
    matchScore: score,
    _i: hit.index
  };
}

function normalizeBase(store, index) {
  if (typeof store === 'string') return { name: cleanStoreName(store), code: String(index + 1).padStart(2, '0'), nav: '', note: '', index };
  if (!store) return null;

  const name = cleanStoreName(store.name || store.storeName || store.title || store.customerName || store['门店名称'] || '');
  if (!name) return null;

  return {
    name,
    code: String(store.code || index + 1).padStart(2, '0'),
    nav: store.nav || store.navigation || store.url || store['导航'] || '',
    note: store.note || store['备注'] || '',
    routeOrder: Number(store.routeOrder || store.code || index + 1) || index + 1,
    index
  };
}

function extractBusinessCode(value) {
  const m = String(value || '').toUpperCase().match(/(?:^|[^A-Z0-9])(JM\d{4,6}|Q\d{3,5}|A\d{4,6})(?:[^A-Z0-9]|$)/);
  return m ? m[1] : '';
}

function matchKey(value) {
  return cleanStoreName(value).replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”"'‘’·\-_/]/g, '').toLowerCase();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const m = a.length;
  const n = b.length;
  if (!m || !n) return 0;

  const prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let left = prev[0];
    prev[0] = i;
    for (let j = 1; j <= n; j++) {
      const up = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, left + cost);
      left = up;
    }
  }
  return 1 - prev[n] / Math.max(m, n);
}

function cleanStoreName(value) {
  return String(value || '').replace(/^[\s\d]+[、.．)）-]+/, '').replace(/^承运订单[：:\s]*/, '').replace(/\s+/g, ' ').trim();
}

function unique(values) {
  const seen = new Set();
  return values.filter(value => {
    const k = matchKey(value);
    if (!k || seen.has(k)) return false;
    seen.add(k);
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
  const text = String(value).trim();
  const match = text.match(/[\d]+(?:\.\d+)?/);
  if (!match) return '';
  const number = Number(match[0]);
  return /吨|\bt\b/i.test(text) ? `${number}t` : `${number}kg`;
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
