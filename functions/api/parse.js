// 天友智配One - 运单文字解析
// 流程：OCR原文 -> 多格式提取门店 -> 基准库匹配 -> 固定配送顺序。
// 基准库是当前线路的唯一门店身份来源；OCR只负责提供候选文字。
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

    // OCR没有箭头或换行结构不稳定时，直接从当前线路基准库反查门店。
    const baseRecognized = extractStoresFromBase(text, base);
    parsed.stores = unique(parsed.stores.concat(baseRecognized));

    // 只有确定性解析仍然无法取得有效门店时，才调用AI兜底。
    if (!parsed.stores.length && env.AI && typeof env.AI.run === 'function') {
      parsed = await parseOrderText(env.AI, text);
      parsed.stores = unique(parsed.stores.concat(baseRecognized));
    }

    const result = normalizeAndSort(parsed.stores, base, text);
    if (!result.stores.length) {
      return json({ success: false, error: '未识别到有效门店，请检查OCR文字后再解析' }, 422);
    }

    const meta = {
      route,
      date: normalizeDate(parsed.date) || normalizeDate(extractDate(text)),
      vehicle: normalizeVehicle(parsed.vehicle) || extractVehicle(text),
      totalWeight: normalizeWeight(parsed.totalWeight) || normalizeWeight(extractWeight(text)),
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

  let body = normalized;
  const marker = body.match(/承运订单\s*[：:]?/);
  if (marker) body = body.slice((marker.index ?? 0) + marker[0].length);

  body = body.split(/(?:总数量|总重量|额定载重|额定装载|额定体积|订单编号|运单编号)\s*[：:]?/)[0];

  const stores = [];

  if (/->/.test(body)) {
    body.split(/\s*(?:->|-->)\s*/)
      .map(cleanStoreName)
      .filter(isLikelyStore)
      .forEach(item => stores.push(item));
  }

  body.split('\n')
    .map(cleanStoreName)
    .filter(isLikelyStore)
    .forEach(item => stores.push(item));

  return { date, vehicle, totalWeight, rawOrderCount, stores: unique(stores) };
}

function extractStoresFromBase(text, baseStores) {
  const compact = matchKey(text);
  const result = [];

  for (const store of baseStores || []) {
    const item = normalizeBase(store, result.length);
    if (!item) continue;

    const code = extractBusinessCode(item.name);
    const key = matchKey(item.name);

    if (code && compact.includes(matchKey(code))) {
      result.push(item.name);
      continue;
    }

    if (key.length >= 8 && compact.includes(key)) {
      result.push(item.name);
      continue;
    }

    const stable = stableStoreKey(item.name);
    if (stable.length >= 7 && compact.includes(stable)) result.push(item.name);
  }

  return unique(result);
}

function stableStoreKey(value) {
  const key = matchKey(value)
    .replace(/^渝北|^江北|^特渠部|^天友加盟|^ii类天友生活|^天友24h/, '');
  return key.length > 24 ? key.slice(-24) : key;
}

async function parseOrderText(AI, text) {
  const prompt = `你是“天友智配One”运单文字解析器。只从OCR原文中提取真实配送门店，不进行基准库匹配。

规则：
1. 箭头 ->、→、＞、》、➜、➤、⇒ 都是门店分隔符。
2. 没有箭头时，按编号行或门店语义识别；不要因为没有箭头就返回空数组。
3. 公司名称因OCR换行拆开时合并成一家门店。
4. “总数量207”只是订单商品数量，不是门店数量。
5. 忽略日期、车牌、总重量、额定载重、订单编号、司机、送货员、金额等字段。
6. 保留Q/JM/A等业务编号和公司名称中的有效信息。
7. 不猜测原文不存在的门店。
8. stores只返回门店名称字符串。

只返回JSON：
{"date":"2026-08-22","vehicle":"渝DK7692","totalWeight":"1.806213t","rawOrderCount":207,"stores":["门店A","门店B"]}

OCR原文：
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

function normalizeAndSort(recognized, baseStores, originalText = '') {
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
  const review = [];
  const news = [];
  const used = new Set();
  const reviewKeys = new Set();
  const newKeys = new Set();

  for (const raw of src) {
    const candidate = findBestBaseMatch(raw, base, byName, byBusinessCode, used);

    if (candidate.type === 'exact') {
      if (!used.has(candidate.item.index)) {
        used.add(candidate.item.index);
        matched.push(toMatched(candidate.item, false, candidate.score));
      }
      continue;
    }

    if (candidate.type === 'duplicate') continue;

    if (candidate.type === 'match') {
      used.add(candidate.item.index);
      matched.push(toMatched(candidate.item, true, candidate.score));
      continue;
    }

    if (candidate.type === 'review') {
      const key = matchKey(raw);
      if (!reviewKeys.has(key)) {
        reviewKeys.add(key);
        review.push({
          code: '',
          name: raw,
          nav: '',
          note: '',
          isNew: false,
          matched: false,
          needsReview: true,
          candidate: candidate.item.name,
          candidates: candidate.alternatives.map(item => item.name),
          matchScore: Number(candidate.score.toFixed(3))
        });
      }
      continue;
    }

    if (isLikelyStore(raw)) {
      const key = matchKey(raw);
      if (!newKeys.has(key)) {
        newKeys.add(key);
        news.push({ code: '', name: raw, nav: '', note: '', isNew: true, matched: false });
      }
    }
  }

  // 最后再从完整OCR原文做一次基准库扫描，但不改变已经确定的门店身份。
  const originalCandidates = extractBaseHitsFromOriginal(originalText, base, used);
  for (const hit of originalCandidates) {
    if (used.has(hit.item.index)) continue;
    used.add(hit.item.index);
    matched.push(toMatched(hit.item, true, hit.score));
  }

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

function findBestBaseMatch(raw, base, byName, byBusinessCode, used) {
  const rk = matchKey(raw);
  if (!rk) return { type: 'new', score: 0 };

  const exact = byName.get(rk);
  if (exact) {
    return used.has(exact.index)
      ? { type: 'duplicate', item: exact, score: 1 }
      : { type: 'exact', item: exact, score: 1 };
  }

  const rawCode = extractBusinessCode(raw);
  if (rawCode) {
    const coded = byBusinessCode.get(rawCode);
    if (coded) {
      return used.has(coded.index)
        ? { type: 'duplicate', item: coded, score: 1 }
        : { type: 'exact', item: coded, score: 1 };
    }
  }

  const scored = base
    .map(item => ({ item, score: storeSimilarity(raw, item.name) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 0.56) return { type: 'new', score: best?.score || 0 };

  if (used.has(best.item.index)) {
    const duplicateThreshold = rawCode && extractBusinessCode(best.item.name) === rawCode ? 0.56 : 0.76;
    if (best.score >= duplicateThreshold && hasStableEvidence(raw, best.item.name)) {
      return { type: 'duplicate', item: best.item, score: best.score };
    }

    const unused = scored.filter(entry => !used.has(entry.item.index));
    if (!unused.length) return { type: 'duplicate', item: best.item, score: best.score };
    const alternate = unused[0];
    if (alternate.score >= 0.82 && alternate.score - best.score >= 0.08) {
      return buildDecision(alternate, unused.slice(0, 3));
    }
    return { type: 'new', score: best.score };
  }

  return buildDecision(best, scored.slice(0, 3));
}

function buildDecision(best, alternatives) {
  const second = alternatives.find(entry => entry.item.index !== best.item.index);
  const margin = second ? best.score - second.score : best.score;
  const length = Math.min(matchKey(best.item.name).length, matchKey(best.item.name).length);
  const keyLength = matchKey(best.item.name).length;

  // 业务编号、长稳定尾部、以及较大的候选差距可以提高自动匹配可信度。
  const raw = alternatives[0]?.raw || '';
  const confidence = best.score >= 0.88 ||
    (best.score >= 0.82 && margin >= 0.06) ||
    (best.score >= 0.78 && keyLength >= 12 && margin >= 0.12);

  if (confidence) return { type: 'match', item: best.item, score: best.score };

  if (best.score >= 0.62 && keyLength >= 5) {
    return {
      type: 'review',
      item: best.item,
      score: best.score,
      alternatives: alternatives.filter(entry => entry.score >= Math.max(0.58, best.score - 0.12)).slice(0, 3).map(entry => entry.item)
    };
  }

  return { type: 'new', score: best.score };
}

function extractBaseHitsFromOriginal(text, base, used) {
  const compact = matchKey(text);
  const hits = [];
  for (const item of base) {
    if (used.has(item.index)) continue;
    const key = matchKey(item.name);
    const code = extractBusinessCode(item.name);
    let score = 0;
    if (code && compact.includes(matchKey(code))) score = 0.97;
    else if (key.length >= 8 && compact.includes(key)) score = 0.94;
    else {
      const stable = stableStoreKey(item.name);
      if (stable.length >= 8 && compact.includes(stable)) score = 0.90;
    }
    if (score) hits.push({ item, score });
  }
  return hits.sort((a, b) => a.item.index - b.item.index);
}

function storeSimilarity(a, b) {
  const ak = matchKey(a);
  const bk = matchKey(b);
  if (!ak || !bk) return 0;
  if (ak === bk) return 1;

  const codeA = extractBusinessCode(a);
  const codeB = extractBusinessCode(b);
  const codeBoost = codeA && codeA === codeB ? 0.30 : 0;

  const stableA = stableStoreKey(a);
  const stableB = stableStoreKey(b);
  const stableScore = tokenOverlap(stableA, stableB);
  const charScore = characterNgramSimilarity(ak, bk, 2);
  const editScore = normalizedEditSimilarity(ak, bk);
  const prefixScore = prefixSimilarity(ak, bk);
  const suffixScore = suffixSimilarity(ak, bk);
  const containment = ak.includes(bk) || bk.includes(ak)
    ? Math.min(ak.length, bk.length) / Math.max(ak.length, bk.length)
    : 0;

  let score =
    editScore * 0.27 +
    charScore * 0.25 +
    stableScore * 0.20 +
    prefixScore * 0.10 +
    suffixScore * 0.10 +
    containment * 0.08;

  if (codeBoost) score = Math.min(1, score + codeBoost);
  if (stableA.length >= 10 && stableScore >= 0.82) score += 0.05;
  if (charScore >= 0.90 && editScore >= 0.82) score += 0.04;
  return Math.min(1, score);
}

function hasStableEvidence(raw, baseName) {
  const a = stableStoreKey(raw);
  const b = stableStoreKey(baseName);
  if (a.length < 7 || b.length < 7) return false;
  return tokenOverlap(a, b) >= 0.72 || characterNgramSimilarity(a, b, 2) >= 0.78;
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
  if (!text) return set;
  for (const part of text.match(/[a-z]+|\d+|[\u4e00-\u9fff]/g) || []) {
    if (part.length >= 2 || /\d/.test(part) || /[a-z]/i.test(part)) set.add(part);
  }
  return set;
}

function characterNgramSimilarity(a, b, n = 2) {
  const sa = ngramSet(a, n);
  const sb = ngramSet(b, n);
  if (!sa.size || !sb.size) return 0;
  let common = 0;
  for (const x of sa) if (sb.has(x)) common++;
  return (2 * common) / (sa.size + sb.size);
}

function ngramSet(value, n) {
  const text = matchKey(value);
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
  if (x === y) return 1;
  const distance = editDistance(x, y);
  return 1 - distance / Math.max(x.length, y.length);
}

function editDistance(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = current;
  }
  return prev[b.length];
}

function prefixSimilarity(a, b) {
  const x = matchKey(a);
  const y = matchKey(b);
  const limit = Math.min(x.length, y.length);
  let i = 0;
  while (i < limit && x[i] === y[i]) i++;
  return limit ? i / limit : 0;
}

function suffixSimilarity(a, b) {
  const x = matchKey(a);
  const y = matchKey(b);
  const limit = Math.min(x.length, y.length);
  let i = 0;
  while (i < limit && x[x.length - 1 - i] === y[y.length - 1 - i]) i++;
  return limit ? i / limit : 0;
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
    matchScore: Number(score.toFixed(3)),
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
