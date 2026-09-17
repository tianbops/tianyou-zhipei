// 天友智配One - 今日运单解析
// OCR原文 -> 元数据 -> 跨行恢复 -> 门店切分 -> 当前用户线路基准库匹配。
// 基准库按线路独立；学习库进一步按用户ID+线路隔离，避免不同账号互相学习。
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
    const userId = normalizeUserId(session.id);
    if (!route || !userId) return json({ success: false, error: '用户资料不完整，请重新登录' }, 403);
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: '服务器基准数据库不可用' }, 500);

    const [base, learning] = await Promise.all([getBaseStores(env, route), getLearning(env, userId, route)]);
    const parsed = parseDeterministic(text);
    const result = matchTodayStores(parsed.stores, base, learning);
    if (!result.stores.length) return json({ success: false, error: '未识别到有效门店，请检查OCR文字后再解析' }, 422);

    const diagnostics = buildDiagnostics(result, parsed.stores.length);
    return json({
      success: true,
      data: {
        route, userId, date: parsed.date, vehicle: parsed.vehicle,
        totalWeight: normalizeWeight(parsed.totalWeight), totalVolume: parsed.totalVolume,
        rawOrderCount: parsed.rawOrderCount, stores: result.stores,
        storeCount: result.stores.length, uniqueStoreCount: result.uniqueStoreCount,
        matchedCount: result.matchedCount, newStoreCount: result.newStoreCount,
        reviewCount: result.reviewCount, duplicateCount: result.duplicateCount,
        learnedCount: result.learnedCount, recognizedCount: parsed.stores.length,
        matchStats: result.matchStats, diagnostics,
        warning: diagnostics.length ? diagnostics[0] : ''
      }
    });
  } catch (error) {
    console.error('parse api error', error);
    return json({ success: false, error: error?.message || '运单文字解析失败' }, 503);
  }
}

function buildDiagnostics(result, recognizedCount) {
  const diagnostics = [];
  if (result.reviewCount) diagnostics.push(`有 ${result.reviewCount} 家门店需要确认`);
  if (result.newStoreCount) diagnostics.push(`有 ${result.newStoreCount} 家新增门店`);
  if (result.duplicateCount) diagnostics.push(`发现 ${result.duplicateCount} 条重复门店记录，已合并`);
  if (!diagnostics.length && recognizedCount > 0) diagnostics.push('解析完成，全部门店已匹配当前线路基准库');
  return diagnostics;
}

function parseDeterministic(text) {
  const source = normalizeOcrText(text);
  return { date: extractDate(source), vehicle: extractVehicle(source), totalWeight: extractWeight(source), totalVolume: extractVolume(source), rawOrderCount: extractRawOrderCount(source), stores: extractStores(source) };
}

function normalizeOcrText(value) {
  return String(value || '').replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u200b\u200c\u200d\ufeff]/g, ' ')
    .replace(/[＞》➜➤⇒↦]/g, '->').replace(/→/g, '->')
    .replace(/[-﹣－—–]\s*\n?\s*[>＞]/g, '->').replace(/-\s*>/g, '->')
    .replace(/\s*->\s*/g, '->').replace(/[｜|]/g, '|').replace(/[，]/g, ',').replace(/[：]/g, ':')
    .replace(/总\s*\n\s*(数量|重量|体积)/g, '总$1').replace(/总\s*数\s*量/g, '总数量')
    .replace(/总\s*重\s*量/g, '总重量').replace(/总\s*体\s*积/g, '总体积')
    .split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').trim();
}

function extractStores(source) {
  const routeText = extractRouteRegion(source);
  if (!routeText) return [];
  const continuous = routeText.replace(/\s+/g, ' ').replace(/\s*->\s*/g, '->').trim();
  if (continuous.includes('->')) return dedupeRawStores(continuous.split('->').map(part => cleanStoreName(stripOrderMetadata(part))).filter(isLikelyStore));
  return dedupeRawStores(routeText.split('\n').map(line => cleanStoreName(stripOrderMetadata(line))).filter(isLikelyStore));
}

function extractRouteRegion(source) {
  const carrierIndex = source.lastIndexOf('承运订单');
  if (carrierIndex >= 0) {
    const cleaned = removeHeaderFields(source.slice(carrierIndex + 4));
    if (cleaned) return cleaned;
  }
  const firstArrow = source.indexOf('->');
  if (firstArrow >= 0) {
    const candidates = source.slice(0, firstArrow).split('\n').map(line => cleanStoreName(stripOrderMetadata(line))).filter(isLikelyStore);
    const first = candidates.at(-1) || '';
    return first ? `${first}${source.slice(firstArrow)}` : source.slice(firstArrow);
  }
  const lines = source.split('\n');
  return lines.slice(findLastHeaderEnd(lines)).filter(line => !isHeaderLine(line)).join('\n');
}

function removeHeaderFields(value) {
  const text = String(value || '').replace(/总\s*\n\s*(数量|重量|体积)/g, '总$1').replace(/总\s*数\s*量/g, '总数量').replace(/总\s*重\s*量/g, '总重量').replace(/总\s*体\s*积/g, '总体积');
  return text.split('\n').filter(line => !isHeaderLine(line)).join('\n').trim();
}

function findLastHeaderEnd(lines) {
  let index = 0;
  for (let i = 0; i < lines.length; i++) if (isHeaderLine(lines[i])) index = i + 1;
  return index;
}

function isHeaderLine(value) {
  const text = String(value || '').replace(/\s/g, '');
  if (!text) return true;
  return /^(?:运单列表|运输日期|车牌号|额定载重|额定装载|额定体积|主司机|送货员|承运订单|总数量|总重量|总体积|订单编号|运单编号|车辆信息|配送信息)/.test(text)
    || /^(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|渝[A-Z0-9]{5,7})$/.test(text);
}

function stripOrderMetadata(value) {
  return String(value || '').replace(/(?:总数量|总重量|总体积|订单编号|运单编号|车牌号|运输日期|主司机|送货员|额定载重|额定体积)\s*[:：]?[^\n]*/gi, ' ')
    .replace(/(?:总数量|总重量|总体积)\s*[:：]?\s*[\d.]+\s*(?:kg|KG|千克|公斤|吨|t)?(?:\s*\([^\)]*\))?/gi, ' ')
    .replace(/^\s*\|\s*/, '').replace(/\s+/g, ' ').trim();
}

function cleanStoreName(value) {
  return String(value || '').replace(/^\s*[\d０-９]+\s*[、.．)）-]+\s*/, '').replace(/^[\s|]+|[\s|]+$/g, '').replace(/\s+/g, ' ').trim();
}

function isLikelyStore(value) {
  const text = cleanStoreName(value), compact = text.replace(/\s/g, '');
  if (!text || text.length < 3 || !/[\u4e00-\u9fff]/.test(text)) return false;
  if (/^(?:运输日期|车牌号|额定装载|额定载重|额定体积|主司机|送货员|承运订单|总数量|总重量|总体积|运单列表)$/.test(compact)) return false;
  return !/^(?:20\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|渝[A-Z0-9]{5,7})$/.test(compact);
}

function dedupeRawStores(stores) {
  const result = [], seen = new Set();
  for (const raw of stores) {
    const name = cleanStoreName(raw), key = name.replace(/\s+/g, '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key); result.push(name);
  }
  return result;
}

function extractDate(source) {
  const match = String(source).match(/(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?/);
  return match ? `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}` : '';
}

function extractVehicle(source) {
  const match = String(source).match(/(?:车牌号\s*[:：]?\s*)?(渝\s*[A-Z0-9]{5,7})/i);
  return match ? match[1].replace(/\s+/g, '').toUpperCase() : '';
}

function extractRawOrderCount(source) {
  const match = String(source).match(/总\s*数量\s*[:：]?\s*(\d+)/);
  return match ? Number(match[1]) : 0;
}

function extractWeight(source) {
  const match = String(source).match(/总\s*重\s*量\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)?/i) || String(source).match(/(?:总重|重量)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(kg|千克|公斤|吨|t)?/i);
  return match ? `${match[1]}${match[2] || ''}` : '';
}

function extractVolume(source) {
  const match = String(source).match(/总\s*体\s*积\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(m³|m3|m²|m2|立方米)/i) || String(source).match(/(?:总体积|体积)\s*[:：]?\s*([\d,]+(?:\.\d+)?)\s*(m³|m3|m²|m2|立方米)/i);
  return match ? `${match[1]}m³` : '';
}

async function getBaseStores(env, route) {
  const data = await redisGet(env, `route:${normalizeRoute(route)}:base`);
  if (!Array.isArray(data?.stores) || !data.stores.length) throw new Error(`未找到${normalizeRoute(route)}独立基准数据库`);
  return data.stores.map((store, index) => normalizeBase(store, index)).filter(Boolean);
}

async function getLearning(env, userId, route) {
  const data = await redisGet(env, learningKey(userId, route));
  if (!data || typeof data !== 'object') return { version: 4, userId, route, aliases: {} };
  return { ...data, version: 4, userId, route, aliases: data.aliases && typeof data.aliases === 'object' ? data.aliases : {} };
}

function learningKey(userId, route) {
  return `user:${encodeKey(userId)}:route:${encodeKey(normalizeRoute(route))}:learning`;
}

function encodeKey(value) {
  return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_');
}

function normalizeUserId(value) {
  return String(value || '').trim().slice(0, 128);
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
  const base = baseStores.map(normalizeBase).filter(Boolean), byName = new Map(), byCode = new Map(), byLearning = new Map();
  for (const item of base) {
    const nameKey = matchKey(item.name);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, item);
    const businessCode = extractBusinessCode(item.name);
    if (businessCode && !byCode.has(businessCode)) byCode.set(businessCode, item);
  }
  for (const [aliasKey, record] of Object.entries(learning?.aliases || {})) {
    const target = (record?.baseKey && byName.get(record.baseKey)) || (record?.baseCode && base.find(item => String(item.code) === String(record.baseCode)));
    if (target && !byLearning.has(aliasKey)) byLearning.set(aliasKey, target);
  }

  const matched = [], review = [], news = [], used = new Set(), canonicalByBaseIndex = new Map();
  const matchStats = { learned: 0, businessCode: 0, exact: 0, similarity: 0, review: 0, new: 0, duplicate: 0 };
  let duplicateCount = 0;
  for (const raw of recognized) {
    const direct = findDirectMatch(raw, byName, byCode, byLearning);
    if (direct && used.has(direct.item.index)) {
      const canonical = canonicalByBaseIndex.get(direct.item.index);
      if (canonical) {
        canonical.duplicateCount = Number(canonical.duplicateCount || 0) + 1;
        canonical.rawNames = Array.isArray(canonical.rawNames) ? canonical.rawNames : [canonical.name];
        if (!canonical.rawNames.includes(raw)) canonical.rawNames.push(raw);
        duplicateCount++; matchStats.duplicate++; continue;
      }
    }
    const hit = findMatch(raw, base, byName, byCode, used, byLearning);
    if (hit.type === 'match') {
      used.add(hit.item.index);
      const item = toMatched(hit.item, hit.mode, hit.score, raw);
      matched.push(item); canonicalByBaseIndex.set(hit.item.index, item);
      matchStats[hit.mode] = Number(matchStats[hit.mode] || 0) + 1;
    } else if (hit.type === 'review') {
      review.push({ code: '', name: raw, nav: '', note: '', isNew: false, matched: false, needsReview: true, matchType: 'review', candidate: hit.item.name, candidates: hit.alternatives.map(item => item.name), candidateCode: hit.item.code, matchScore: Number(hit.score.toFixed(3)), rawName: raw, rawNames: [raw] });
      matchStats.review++;
    } else {
      news.push({ code: '', name: raw, nav: '', note: '', isNew: true, matched: false, matchType: 'new', matchScore: Number(hit.score || 0), rawName: raw, rawNames: [raw] });
      matchStats.new++;
    }
  }
  matched.sort((a, b) => a._i - b._i);
  matched.forEach((item, index) => { item.code = String(index + 1).padStart(2, '0'); });
  review.forEach((item, index) => { item.code = `R${String(index + 1).padStart(2, '0')}`; });
  news.forEach((item, index) => { item.code = `N${String(index + 1).padStart(2, '0')}`; });
  const stores = matched.concat(review, news).map(({ _i, ...item }) => item);
  return { stores, matchedCount: matched.length, reviewCount: review.length, newStoreCount: news.length, duplicateCount, learnedCount: matchStats.learned, uniqueStoreCount: stores.length, matchStats };
}

function findDirectMatch(raw, byName, byCode, byLearning) {
  const learned = byLearning.get(matchKey(raw));
  if (learned) return { type: 'match', item: learned, mode: 'learned', score: 1 };
  const businessCode = extractBusinessCode(raw);
  if (businessCode && byCode.has(businessCode)) return { type: 'match', item: byCode.get(businessCode), mode: 'businessCode', score: 1 };
  const key = matchKey(raw);
  if (key && byName.has(key)) return { type: 'match', item: byName.get(key), mode: 'exact', score: 1 };
  return null;
}

function findMatch(raw, base, byName, byCode, used, byLearning) {
  const direct = findDirectMatch(raw, byName, byCode, byLearning);
  if (direct && !used.has(direct.item.index)) return direct;
  const businessCode = extractBusinessCode(raw);
  if (businessCode) {
    const candidate = base.find(item => extractBusinessCode(item.name) === businessCode && !used.has(item.index));
    if (candidate) return { type: 'match', item: candidate, mode: 'businessCode', score: 1 };
  }
  const candidates = base.filter(item => !used.has(item.index)).map(item => ({ item, score: storeSimilarity(raw, item.name) })).sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return { type: 'new', score: 0 };
  const second = candidates[1], margin = second ? best.score - second.score : best.score;
  if (best.score >= 0.84 || (best.score >= 0.76 && margin >= 0.045) || (best.score >= 0.70 && margin >= 0.10)) return { type: 'match', item: best.item, mode: 'similarity', score: best.score };
  if (best.score >= 0.56) return { type: 'review', item: best.item, score: best.score, alternatives: candidates.slice(0, 3).map(x => x.item) };
  return { type: 'new', score: best.score };
}

function storeSimilarity(a, b) {
  const ak = matchKey(a), bk = matchKey(b);
  if (!ak || !bk) return 0;
  if (ak === bk) return 1;
  const codeA = extractBusinessCode(a), codeB = extractBusinessCode(b);
  if (codeA && codeA === codeB) return 1;
  const edit = normalizedEditSimilarity(ak, bk), ngram = characterNgramSimilarity(ak, bk), token = tokenOverlap(stableStoreKey(a), stableStoreKey(b));
  const containment = ak.includes(bk) || bk.includes(ak) ? Math.min(ak.length, bk.length) / Math.max(ak.length, bk.length) : 0;
  return Math.min(1, edit * 0.38 + ngram * 0.34 + token * 0.20 + containment * 0.08);
}

function stableStoreKey(value) { return matchKey(value).replace(/^(?:渝北|江北|特渠部|天友加盟|天友24h)/, ''); }
function tokenOverlap(a, b) { const aa = meaningfulTokens(a), bb = meaningfulTokens(b); if (!aa.size || !bb.size) return 0; let common = 0; for (const token of aa) if (bb.has(token)) common++; return common / Math.max(aa.size, bb.size); }
function meaningfulTokens(value) { const set = new Set(); for (const token of matchKey(value).match(/[a-z]+|\d+|[\u4e00-\u9fff]+/g) || []) if (token.length >= 2 || /\d/.test(token) || /[a-z]/i.test(token)) set.add(token); return set; }
function characterNgramSimilarity(a, b, n = 2) { const aa = ngramSet(a, n), bb = ngramSet(b, n); if (!aa.size || !bb.size) return 0; let common = 0; for (const value of aa) if (bb.has(value)) common++; return (2 * common) / (aa.size + bb.size); }
function ngramSet(value, n) { const text = String(value || ''); const set = new Set(); if (text.length <= n) { if (text) set.add(text); return set; } for (let i = 0; i <= text.length - n; i++) set.add(text.slice(i, i + n)); return set; }
function normalizedEditSimilarity(a, b) { const aa = String(a || ''), bb = String(b || ''); if (aa === bb) return 1; if (!aa || !bb) return 0; return 1 - levenshtein(aa, bb) / Math.max(aa.length, bb.length); }
function levenshtein(a, b) { if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length; let previous = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { const current = [i]; for (let j = 1; j <= b.length; j++) { const cost = a[i - 1] === b[j - 1] ? 0 : 1; current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost); } previous = current; } return previous[b.length]; }

function normalizeBase(store, index) {
  if (typeof store === 'string') return { name: cleanStoreName(store), code: String(index + 1).padStart(2, '0'), index };
  if (!store) return null;
  const name = cleanStoreName(store.name || store.storeName || store.title || store.customerName || store['门店名称'] || '');
  return name ? { ...store, name, code: String(store.code || index + 1).trim(), index } : null;
}

function toMatched(item, mode, score, rawName) {
  return { code: item.code, name: item.name, nav: item.nav || item.navigation || item.navUrl || item.amap || '', note: item.note || item.remark || '', isNew: false, matched: true, needsReview: false, matchType: mode, matchScore: Number(score || 0), baseName: item.name, baseCode: String(item.code || ''), rawName, rawNames: [rawName], _i: item.index };
}

function extractBusinessCode(value) {
  const text = String(value || '').toUpperCase(), match = text.match(/(?:^|[^A-Z0-9])((?:JM|Q|A)\s*\d{3,8})(?!\d)/);
  return match ? match[1].replace(/\s+/g, '') : '';
}

function matchKey(value) {
  const romanMap = { 'Ⅱ': 'II', 'Ⅲ': 'III', 'Ⅳ': 'IV', 'Ⅴ': 'V', 'Ⅵ': 'VI', 'Ⅶ': 'VII', 'Ⅷ': 'VIII', 'Ⅸ': 'IX', 'Ⅹ': 'X' };
  return cleanStoreName(value).replace(/[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g, roman => romanMap[roman] || roman)
    .replace(/[∥〢丨]/g, 'II').replace(/谊品鲜/g, '谊品生鲜').replace(/客户中心/g, '客服中心')
    .replace(/[（(]\s*(?:临时|20\d{2})\s*[）)]/g, '')
    .replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g, '').toLowerCase();
}

function normalizeRoute(value) {
  const text = String(value || '').trim(), match = text.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
  return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : text;
}

function normalizeWeight(value) {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value).trim().replace(/,/g, ''), match = text.match(/[\d]+(?:\.\d+)?/);
  if (!match) return '';
  const n = Number(match[0]); if (!Number.isFinite(n)) return '';
  if (/吨|\bt\b/i.test(text)) return `${n}t`;
  if (/kg|千克|公斤/i.test(text)) return `${n / 1000}t`;
  return `${n >= 1000 ? n / 1000 : n}t`;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
