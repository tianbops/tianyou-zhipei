// 天友智配One - 今日运单解析
// OCR原文 -> 清理运单元数据 -> 重组门店 -> 当前线路基准库匹配。
// 解析规则与具体线路数据完全分离；用户确认过的别名只进入当前线路独立学习库。
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
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: '服务器基准数据库不可用' }, 500);
    const base = await getBaseStores(env, route);
    const learning = await getLearning(env, route);
    const parsed = parseDeterministic(text);
    const result = matchTodayStores(parsed.stores, base, learning);
    if (!result.stores.length) return json({ success: false, error: '未识别到有效门店，请检查OCR文字后再解析' }, 422);
    return json({ success: true, data: {
      route, date: parsed.date, vehicle: parsed.vehicle,
      totalWeight: normalizeWeight(parsed.totalWeight), rawOrderCount: parsed.rawOrderCount,
      stores: result.stores, storeCount: result.stores.length, uniqueStoreCount: result.uniqueStoreCount,
      matchedCount: result.matchedCount, newStoreCount: result.newStoreCount, reviewCount: result.reviewCount,
      duplicateCount: result.duplicateCount, learnedCount: result.learnedCount, recognizedCount: parsed.stores.length,
      warning: result.reviewCount ? `发现 ${result.reviewCount} 家门店需要确认` : result.newStoreCount ? `发现 ${result.newStoreCount} 家新增门店，请核对` : result.duplicateCount ? `识别到 ${result.duplicateCount} 条重复门店记录，已合并` : ''
    }});
  } catch (error) {
    console.error('parse api error', error);
    return json({ success: false, error: error?.message || '运单文字解析失败' }, 503);
  }
}

function parseDeterministic(text) {
  const source = normalizeOcrText(text);
  return { date: extractDate(source), vehicle: extractVehicle(source), totalWeight: extractWeight(source), rawOrderCount: extractRawOrderCount(source), stores: extractStores(source) };
}

function normalizeOcrText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n').replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
    .replace(/[＞》➜➤⇒↦]/g, '->').replace(/→/g, '->')
    .replace(/[-﹣－—–]\s*\n?\s*[>＞]/g, '->').replace(/-\s*>/g, '->').replace(/\s*->\s*/g, '->')
    .replace(/(^|\n)\s*[>＞]\s*(?=\n|$)/g, '$1->').replace(/[｜|]/g, '|').replace(/[，]/g, ',').replace(/[：]/g, ':')
    .replace(/总\s*\n\s*(数量|重量|体积)/g, '总$1').replace(/总\s*数\s*量/g, '总数量')
    .replace(/总\s*重\s*量/g, '总重量').replace(/总\s*体\s*积/g, '总体积')
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').trim();
}

function extractStores(source) {
  const routeText = extractRouteRegion(source);
  if (!routeText) return [];
  const parts = routeText.split(/\s*->\s*/);
  const stores = parts.map(part => cleanStoreName(stripOrderMetadata(part))).filter(isLikelyStore);
  if (stores.length >= 2) return dedupeRawStores(stores);
  return dedupeRawStores(routeText.split('\n').map(line => cleanStoreName(stripOrderMetadata(line))).filter(isLikelyStore));
}

function extractRouteRegion(source) {
  const carrierIndex = source.lastIndexOf('承运订单');
  if (carrierIndex >= 0) {
    const cleaned = removeHeaderFields(source.slice(carrierIndex + '承运订单'.length));
    if (cleaned) return cleaned;
  }
  const firstArrow = source.indexOf('->');
  if (firstArrow >= 0) {
    const before = source.slice(0, firstArrow);
    const candidates = before.split('\n').map(line => cleanStoreName(stripOrderMetadata(line))).filter(isLikelyStore);
    const first = candidates.length ? candidates[candidates.length - 1] : '';
    return first ? `${first}${source.slice(firstArrow)}` : source.slice(firstArrow);
  }
  const lines = source.split('\n');
  const start = findLastHeaderEnd(lines);
  return lines.slice(start).filter(line => !isHeaderLine(line)).join('\n');
}

function removeHeaderFields(value) {
  let text = String(value || '').replace(/总\s*\n\s*(数量|重量|体积)/g, '总$1').replace(/总\s*数\s*量/g, '总数量').replace(/总\s*重\s*量/g, '总重量').replace(/总\s*体\s*积/g, '总体积');
  text = text.split('\n').filter(line => !isHeaderLine(line)).join('\n');
  text = text.replace(/(?:总数量|总重量|总体积|订单编号|运单编号|车牌号|运输日期|主司机|送货员|额定载重|额定体积)\s*[:：]?[^\n]*/gi, '')
    .replace(/(?:^|\n)\s*体积\s*[\d]+(?:\.\d+)?\s*(?:m³|m3|立方米)(?:\s*\([^\n]*?\))?\s*/gi, '$1').trim();
  return text;
}

function findLastHeaderEnd(lines) { let index = 0; for (let i = 0; i < lines.length; i++) if (isHeaderLine(lines[i])) index = i + 1; return index; }
function isHeaderLine(value) {
  const text = String(value || '').replace(/\s/g, '');
  if (!text) return true;
  return /^(?:运单列表|运输日期|车牌号|额定载重|额定装载|额定体积|主司机|送货员|承运订单|总数量|总重量|总体积|订单编号|运单编号|车辆信息|配送信息)/.test(text)
    || /^(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|渝[A-Z0-9]{5,7})$/.test(text);
}

function stripOrderMetadata(value) {
  return String(value || '')
    .replace(/(?:总数量|总重量|总体积|订单编号|运单编号|车牌号|运输日期|主司机|送货员|额定载重|额定体积)\s*[:：]?[^^\n]*/gi, ' ')
    .replace(/(?:总数量|总重量|总体积)\s*[:：]?\s*[\d.]+\s*(?:kg|KG|千克|公斤|吨|t)?(?:\s*\([^\)]*\))?/gi, ' ')
    .replace(/(?:^|\n)\s*体积\s*[\d]+(?:\.\d+)?\s*(?:m³|m3|立方米)(?:\s*\([^\n]*?\))?/gi, ' ')
    .replace(/^\s*\|\s*/, '').replace(/\s+/g, ' ').trim();
}

async function getBaseStores(env, route) {
  const key = `route:${normalizeRoute(route)}:base`;
  const data = await redisGet(env, key);
  if (!Array.isArray(data?.stores) || !data.stores.length) throw new Error(`未找到${normalizeRoute(route)}独立基准数据库`);
  return data.stores;
}

async function getLearning(env, route) {
  const data = await redisGet(env, `route:${normalizeRoute(route)}:learning`);
  return data && typeof data === 'object' ? data : { version: 1, aliases: {} };
}

async function redisGet(env, key) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!response.ok) throw new Error('Redis读取失败');
  const data = await response.json().catch(() => ({}));
  if (data?.result === null || data?.result === undefined || data?.result === '') return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
}

function matchTodayStores(recognized, baseStores, learning) {
  const base = baseStores.map(normalizeBase).filter(Boolean);
  const byName = new Map(), byCode = new Map(), byLearning = new Map();
  for (const item of base) {
    const key = matchKey(item.name); if (key && !byName.has(key)) byName.set(key, item);
    const code = extractBusinessCode(item.name); if (code && !byCode.has(code)) byCode.set(code, item);
  }
  const aliases = learning?.aliases && typeof learning.aliases === 'object' ? learning.aliases : {};
  for (const [aliasKey, record] of Object.entries(aliases)) {
    const target = (record?.baseKey && byName.get(record.baseKey)) || (record?.baseCode && byCode.get(String(record.baseCode))) || null;
    if (target && !byLearning.has(aliasKey)) byLearning.set(aliasKey, target);
  }

  const matched = [], review = [], news = [], used = new Set(), canonicalByBaseIndex = new Map();
  let duplicateCount = 0, learnedCount = 0;
  for (const raw of recognized) {
    const learned = findLearnedMatch(raw, byLearning);
    const direct = learned ? { type: 'match', item: learned, mode: 'learned', score: 1 } : findDirectMatch(raw, byName, byCode);
    if (direct && used.has(direct.item.index)) {
      const canonical = canonicalByBaseIndex.get(direct.item.index);
      if (canonical) {
        canonical.duplicateCount = Number(canonical.duplicateCount || 0) + 1;
        canonical.rawNames = Array.isArray(canonical.rawNames) ? canonical.rawNames : [canonical.name];
        if (!canonical.rawNames.includes(raw)) canonical.rawNames.push(raw);
        duplicateCount++; continue;
      }
    }
    const hit = findMatch(raw, base, byName, byCode, used, byLearning);
    if (hit.type === 'match') {
      used.add(hit.item.index);
      const item = toMatched(hit.item, hit.mode, hit.score, raw);
      matched.push(item); canonicalByBaseIndex.set(hit.item.index, item);
      if (hit.mode === 'learned') learnedCount++;
    } else if (hit.type === 'review') {
      review.push({ code: '', name: raw, nav: '', note: '', isNew: false, matched: false, needsReview: true,
        candidate: hit.item.name, candidates: hit.alternatives.map(item => item.name), candidateCode: hit.item.code,
        matchScore: Number(hit.score.toFixed(3)), rawNames: [raw] });
    } else news.push({ code: '', name: raw, nav: '', note: '', isNew: true, matched: false, rawNames: [raw] });
  }
  matched.sort((a, b) => a._i - b._i);
  matched.forEach((item, i) => { item.code = String(i + 1).padStart(2, '0'); });
  review.forEach((item, i) => { item.code = `R${String(i + 1).padStart(2, '0')}`; });
  news.forEach((item, i) => { item.code = `N${String(i + 1).padStart(2, '0')}`; });
  const stores = matched.concat(review, news).map(({ _i, ...item }) => item);
  return { stores, matchedCount: matched.length, reviewCount: review.length, newStoreCount: news.length, duplicateCount, learnedCount, uniqueStoreCount: stores.length };
}

function findLearnedMatch(raw, byLearning) { return byLearning.get(matchKey(raw)) || null; }

function findDirectMatch(raw, byName, byCode) {
  const code = extractBusinessCode(raw); if (code && byCode.has(code)) return { type: 'match', item: byCode.get(code), mode: 'businessCode', score: 1 };
  const key = matchKey(raw); if (key && byName.has(key)) return { type: 'match', item: byName.get(key), mode: 'exact', score: 1 };
  return null;
}

function findMatch(raw, base, byName, byCode, used, byLearning) {
  const learned = findLearnedMatch(raw, byLearning);
  if (learned && !used.has(learned.index)) return { type: 'match', item: learned, mode: 'learned', score: 1 };
  const direct = findDirectMatch(raw, byName, byCode); if (direct && !used.has(direct.item.index)) return direct;
  const code = extractBusinessCode(raw);
  if (code) {
    const codeCandidate = base.find(item => extractBusinessCode(item.name) === code && !used.has(item.index));
    if (codeCandidate) return { type: 'match', item: codeCandidate, mode: 'businessCode', score: 1 };
  }
  const candidates = base.filter(item => !used.has(item.index)).map(item => ({ item, score: storeSimilarity(raw, item.name) })).sort((a, b) => b.score - a.score);
  const best = candidates[0]; if (!best) return { type: 'new', score: 0 };
  const second = candidates[1], margin = second ? best.score - second.score : best.score;
  if (best.score >= 0.84 || (best.score >= 0.76 && margin >= 0.045) || (best.score >= 0.70 && margin >= 0.10)) return { type: 'match', item: best.item, mode: 'similarity', score: best.score };
  if (best.score >= 0.56) return { type: 'review', item: best.item, score: best.score, alternatives: candidates.slice(0, 3).map(x => x.item) };
  return { type: 'new', score: best.score };
}

function storeSimilarity(a, b) {
  const ak = matchKey(a), bk = matchKey(b); if (!ak || !bk) return 0; if (ak === bk) return 1;
  const codeA = extractBusinessCode(a), codeB = extractBusinessCode(b); if (codeA && codeA === codeB) return 1;
  const edit = normalizedEditSimilarity(ak, bk), ngram = characterNgramSimilarity(ak, bk), token = tokenOverlap(stableStoreKey(a), stableStoreKey(b));
  const containment = ak.includes(bk) || bk.includes(ak) ? Math.min(ak.length, bk.length) / Math.max(ak.length, bk.length) : 0;
  return Math.min(1, edit * 0.38 + ngram * 0.34 + token * 0.20 + containment * 0.08);
}

function stableStoreKey(value) { return matchKey(value).replace(/^(?:渝北|江北|特渠部|天友加盟|天友24h)/, ''); }
function tokenOverlap(a, b) { const aa = meaningfulTokens(a), bb = meaningfulTokens(b); if (!aa.size || !bb.size) return 0; let common = 0; for (const token of aa) if (bb.has(token)) common++; return common / Math.max(aa.size, bb.size); }
function meaningfulTokens(value) { const set = new Set(); for (const token of matchKey(value).match(/[a-z]+|\d+|[\u4e00-\u9fff]+/g) || []) if (token.length >= 2 || /\d/.test(token) || /[a-z]/i.test(token)) set.add(token); return set; }
function characterNgramSimilarity(a, b, n = 2) { const aa = ngramSet(matchKey(a), n), bb = ngramSet(matchKey(b), n); if (!aa.size || !bb.size) return 0; let common = 0; for (const value of aa) if (bb.has(value)) common++; return (2 * common) / (aa.size + bb.size); }
function ngramSet(text, n) { const set = new Set(); if (!text) return set; if (text.length <= n) return set.add(text); for (let i = 0; i <= text.length - n; i++) set.add(text.slice(i, i + n)); return set; }
function normalizedEditSimilarity(a, b) { const x = matchKey(a), y = matchKey(b); if (!x || !y) return 0; return 1 - editDistance(x, y) / Math.max(x.length, y.length); }
function editDistance(a, b) { if (a === b) return 0; let previous = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { const current = [i]; for (let j = 1; j <= b.length; j++) { const cost = a[i - 1] === b[j - 1] ? 0 : 1; current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost); } previous = current; } return previous[b.length]; }

function toMatched(item, mode, score, raw) { return { code: item.code, name: item.name, nav: item.nav, note: item.note, isNew: false, matched: true, matchType: mode, matchScore: Number(score.toFixed(3)), rawNames: [raw], _i: item.index }; }
function normalizeBase(store, index) {
  if (typeof store === 'string') { const name = cleanStoreName(store); return name ? { name, code: String(index + 1).padStart(2, '0'), nav: '', note: '', index } : null; }
  if (!store) return null;
  const name = cleanStoreName(store.name || store.storeName || store.title || store.customerName || store['门店名称'] || '');
  if (!name) return null;
  return { name, code: String(store.code || index + 1).padStart(2, '0'), nav: store.nav || store.navigation || store.url || store['导航'] || '', note: store.note || store['备注'] || '', index };
}

function extractBusinessCode(value) {
  const text = normalizeCodeText(value);
  const match = text.match(/(?:^|[^A-Z0-9])(JM\s*\d{4,6}|Q\s*\d{3,5}|A\s*\d{4,6})(?:[^A-Z0-9]|$)/);
  return match ? match[1].replace(/[\s-]/g, '') : '';
}
function normalizeCodeText(value) {
  return String(value || '').toUpperCase().replace(/[ＯО]/g, 'O').replace(/[Ｑ]/g, 'Q').replace(/[Ａ]/g, 'A').replace(/[Ｊ]/g, 'J').replace(/[Ｍ]/g, 'M');
}
function matchKey(value) {
  const romanMap = { 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V', 'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII', 'Ⅸ': 'IX', 'Ⅹ': 'X' };
  const text = cleanStoreName(value)
    .replace(/[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, roman => romanMap[roman] || roman)
    .replace(/[∥〢丨]/g, 'II').replace(/\b(?:II|III)I(?=类)/gi, m => m.slice(0, -1).toUpperCase())
    .replace(/\bII\s*类/gi, 'II类').replace(/\bIII\s*类/gi, 'III类').replace(/[（(]\s*(?:临时|20\d{2})\s*[）)]/g, '')
    .replace(/谊品鲜/g, '谊品生鲜').replace(/客户中心/g, '客服中心').replace(/客服中\s*心/g, '客服中心');
  return text.replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g, '').toLowerCase();
}
function cleanStoreName(value) { return String(value || '').replace(/^[\s\d]+[、.．)）-]+/, '').replace(/^承运订单[：:\s]*/, '').replace(/^[)>）]+\s*/, '').replace(/\s*[<(（]+\s*$/, '').replace(/[)>）]+\s*$/, '').replace(/\s+/g, ' ').trim(); }
function isLikelyStore(value) {
  const text = String(value || '').trim(); if (!text || text.length < 3 || text.length > 160) return false;
  if (/总重量|总数量|总体积|订单编号|运单编号|车牌|车辆|运输日期|日期|司机|送货员|主司机|承运订单|额定装载|额定载重|额定体积|总计|合计|单价|金额/.test(text)) return false;
  if (/^(?:\d+(?:\.\d+)?|[A-Z]{1,3}\d{3,8})$/.test(text)) return false;
  return /[\u4e00-\u9fff]/.test(text) || /[A-Za-z]/.test(text);
}
function dedupeRawStores(stores) { const seen = new Set(), result = []; for (const store of stores) { const cleaned = cleanStoreName(store), key = matchKey(cleaned); if (!key || seen.has(key)) continue; seen.add(key); result.push(cleaned); } return result; }
function extractDate(value) { const match = String(value || '').match(/(20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?)/); return match ? normalizeDate(match[1]) : ''; }
function extractVehicle(value) { const source = String(value || '').replace(/[\s>]/g, ''); const match = source.match(/(?:车牌号|车牌|车辆)[:：]?([\u4e00-\u9fa5][A-Z0-9]{5,7})/i); return match ? normalizeVehicle(match[1]) : ''; }
function extractWeight(value) { const source = String(value || '').replace(/\s+/g, ' '); const match = source.match(/总\s*重\s*量\s*[:：]?\s*([\d]+(?:\.[\d]+)?)\s*(kg|KG|千克|公斤|吨|t)?/i); if (match) return `${match[1]}${match[2] || ''}`.trim(); const fallback = source.match(/(?:总重|重量)\s*[:：]?\s*([\d]+(?:\.[\d]+)?)\s*(kg|KG|千克|公斤|吨|t)?/i); return fallback ? `${fallback[1]}${fallback[2] || ''}`.trim() : ''; }
function extractRawOrderCount(value) { const match = String(value || '').match(/总\s*数\s*量\s*[:：]?\s*(\d+)/); return match ? Number(match[1]) : 0; }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const text = String(value).trim().replace(/,/g, ''); const match = text.match(/[\d]+(?:\.\d+)?/); if (!match) return ''; const number = Number(match[0]); if (!Number.isFinite(number) || number < 0) return ''; const hasKg = /kg|千克|公斤/i.test(text), hasTon = /吨|\bt\b/i.test(text); const tons = hasTon ? number : hasKg ? number / 1000 : number >= 100 ? number / 1000 : number; return `${tons.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}t`; }
function normalizeDate(value) { const text = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'); const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/); return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : text; }
function normalizeVehicle(value) { return String(value || '').trim().replace(/\s+/g, '').toUpperCase(); }
function normalizeRoute(value) { const text = String(value || '').trim(); const match = text.match(/^(?:([0-9]+)|([0-9]+)号线)$/); return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : text; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
