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

    const startedAt = Date.now();
    const deadline = startedAt + 120000;
    const [base, learning] = await Promise.all([
      getBaseStores(env, route, deadline),
      getLearning(env, userId, route, deadline)
    ]);
    const dataReadyAt = Date.now();
    const parsed = parseDeterministic(text);
    const extractionDoneAt = Date.now();
    const result = matchTodayStores(parsed.stores, base, learning);
    const planningDoneAt = Date.now();
    if (!result.stores.length) return json({ success: false, error: '未识别到有效门店，请检查OCR文字后再规划路线' }, 422);

    const diagnostics = buildDiagnostics(result, parsed.stores.length);
    const timings = {
      totalMs: planningDoneAt - startedAt,
      databaseMs: dataReadyAt - startedAt,
      extractionMs: extractionDoneAt - dataReadyAt,
      planningMs: planningDoneAt - extractionDoneAt,
      recognizedCount: parsed.stores.length,
      baseStoreCount: base.length
    };
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
        matchStats: result.matchStats, diagnostics, timings,
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
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  const result = [];
  const valueOnly = /^[\d,.]+\s*(?:kg|KG|千克|公斤|吨|t|m3|m²|m³|立方米)(?:\s*\([^)]*\))?$/i;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isHeaderLine(line)) {
      if (/^(?:总数量|总重量|总体积)$/.test(line.replace(/\s/g, '')) && valueOnly.test(lines[i + 1] || '')) i++;
      continue;
    }
    result.push(line);
  }
  return result.join('\n').trim();
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
  return String(value || '')
    .replace(/^\s*[\d０-９]+\s*[、.．)）-]+\s*/, '')
    .replace(/^\s*[\d,.]+\s*m(?:²|³|2|3)\s*(?:\([^)]*\))?\s*/i, '')
    .replace(/^[\s|]+|[\s|]+$/g, '')
    .replace(/\s+/g, ' ').trim();
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

async function getBaseStores(env, route, deadline) {
  const data = await redisGet(env, `route:${normalizeRoute(route)}:base`, deadline);
  if (!Array.isArray(data?.stores) || !data.stores.length) throw new Error(`未找到${normalizeRoute(route)}独立基准数据库`);
  return data.stores.map((store, index) => normalizeBase(store, index)).filter(Boolean);
}

async function getLearning(env, userId, route, deadline) {
  const data = await redisGet(env, learningKey(userId, route), deadline);
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

const REDIS_TIMEOUT_MS = 15000;
async function redisGet(env, key, deadline = Date.now() + REDIS_TIMEOUT_MS) {
  const url = String(env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
  const controller = new AbortController();
  const remaining = Math.max(1, Math.min(REDIS_TIMEOUT_MS, deadline - Date.now()));
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const response = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Redis读取失败（HTTP ${response.status}）`);
    const data = await response.json().catch(() => ({}));
    if (data?.result === null || data?.result === undefined || data?.result === '') return null;
    try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('Redis读取超时（已达到解析时间预算）');
    if (/Redis读取失败/.test(String(error?.message || ''))) throw error;
    throw new Error('Redis网络请求失败');
  } finally {
    clearTimeout(timer);
  }
}

function matchTodayStores(recognized, baseStores, learning) {
  const base = Array.isArray(baseStores) ? baseStores.filter(Boolean) : [], byName = new Map(), byCode = new Map(), byBaseCode = new Map(), byNameLength = new Map(), byWeakName = new Map(), byNgram = new Map(), byLearning = new Map();
  for (const item of base) {
    for (const candidateName of getBaseMatchNames(item)) {
      const nameKey = matchKey(candidateName);
      if (nameKey && !byName.has(nameKey)) byName.set(nameKey, item);
      if (nameKey) {
        const bucket = byNameLength.get(nameKey.length) || [];
        if (!bucket.includes(item)) bucket.push(item);
        byNameLength.set(nameKey.length, bucket);
      }
      const weakKey = weakMatchKey(candidateName);
      if (weakKey) {
        const existing = byWeakName.get(weakKey);
        if (existing === undefined) byWeakName.set(weakKey, item);
        else if (existing !== item) byWeakName.set(weakKey, null);
      }
      const businessCode = extractBusinessCode(candidateName);
      if (businessCode && !byCode.has(businessCode)) byCode.set(businessCode, item);
      const baseCode = String(item.code || '').trim();
      if (baseCode && !byBaseCode.has(baseCode)) byBaseCode.set(baseCode, item);
      for (const gram of ngramSet(nameKey, 2)) {
        const gramBucket = byNgram.get(gram) || [];
        if (!gramBucket.includes(item)) gramBucket.push(item);
        byNgram.set(gram, gramBucket);
      }
    }
  }
  for (const [aliasKey, record] of Object.entries(learning?.aliases || {})) {
    const target = (record?.baseKey && byName.get(record.baseKey)) || (record?.baseCode && byBaseCode.get(String(record.baseCode)));
    if (target && !byLearning.has(aliasKey)) byLearning.set(aliasKey, target);
  }

  const matched = [], review = [], news = [], used = new Set(), canonicalByBaseIndex = new Map();
  // 仅在本次请求内复用OCR门店候选与相似度计算；不跨用户、线路或请求缓存，避免数据串线。
  const similarityCache = new Map();
  const keyFeatureCache = new Map();
  const matchStats = { learned: 0, businessCode: 0, exact: 0, similarity: 0, review: 0, new: 0, duplicate: 0 };
  let duplicateCount = 0;
  for (const raw of recognized) {
    const direct = findDirectMatch(raw, byName, byCode, byLearning, byWeakName, byNameLength);
    if (direct && used.has(direct.item.index)) {
      const canonical = canonicalByBaseIndex.get(direct.item.index);
      if (canonical) {
        canonical.duplicateCount = Number(canonical.duplicateCount || 0) + 1;
        canonical.rawNames = Array.isArray(canonical.rawNames) ? canonical.rawNames : [canonical.name];
        if (!canonical.rawNames.includes(raw)) canonical.rawNames.push(raw);
        duplicateCount++; matchStats.duplicate++; continue;
      }
    }
    const hit = findMatch(raw, byName, byCode, used, byLearning, byWeakName, byNameLength, byNgram, similarityCache, keyFeatureCache);
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

function findUniqueOneCharOmissionMatch(raw, byName, byNameLength) {
  const rawKey = matchKey(raw);
  if (!rawKey || rawKey.length < 7) return null;
  const candidates = [];
  const bucket = byNameLength.get(rawKey.length + 1) || [];
  for (const item of bucket) {
    const baseKey = matchKey(item.name);
    let i = 0, j = 0, skipped = false;
    while (i < rawKey.length && j < baseKey.length) {
      if (rawKey[i] === baseKey[j]) { i++; j++; }
      else if (!skipped) { skipped = true; j++; }
      else { skipped = false; break; }
    }
    if (skipped || j === baseKey.length) candidates.push(item);
    if (candidates.length > 1) return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function findUniqueOneCharInsertionMatch(raw, byNameLength) {
  const rawKey = matchKey(raw);
  if (!rawKey || rawKey.length < 7) return null;
  const candidates = [];
  const bucket = byNameLength.get(rawKey.length - 1) || [];
  for (const item of bucket) {
    const baseKey = matchKey(item.name);
    if (isOneCharEdit(rawKey, baseKey)) candidates.push(item);
    if (candidates.length > 1) return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function findUniqueOneCharSubstitutionMatch(raw, byNameLength) {
  const rawKey = matchKey(raw);
  if (!rawKey || rawKey.length < 7) return null;
  const candidates = [];
  const bucket = byNameLength.get(rawKey.length) || [];
  for (const item of bucket) {
    const baseKey = matchKey(item.name);
    if (isOneCharEdit(rawKey, baseKey)) candidates.push(item);
    if (candidates.length > 1) return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// 判断两个已归一化名称是否只相差1个字符。
// 用于OCR单字符插入/替换的快速唯一候选匹配；长度差1时允许一次插入/删除，长度相同时允许一次替换。
function isOneCharEdit(a, b) {
  const aa = String(a || ''), bb = String(b || '');
  if (!aa || !bb) return false;
  if (aa === bb) return false;
  if (Math.abs(aa.length - bb.length) > 1) return false;

  let i = 0, j = 0, edits = 0;
  while (i < aa.length && j < bb.length) {
    if (aa[i] === bb[j]) {
      i++; j++;
      continue;
    }
    edits++;
    if (edits > 1) return false;
    if (aa.length > bb.length) i++;
    else if (bb.length > aa.length) j++;
    else { i++; j++; }
  }
  edits += (aa.length - i) + (bb.length - j);
  return edits === 1;
}

// OCR偶发连续漏字：最多允许2个字符缺失，但必须在当前线路基准库中得到唯一候选。
// 只处理“原文比基准短”的删除型误差，不把任意两字符改写都自动吞掉。
function findUniqueShortOmissionMatch(raw, byName, byNameLength) {
  const rawKey = matchKey(raw);
  if (!rawKey || rawKey.length < 8) return null;
  const candidates = [];
  const bucket = byNameLength.get(rawKey.length + 2) || [];
  for (const item of bucket) {
    const baseKey = matchKey(item.name);
    const delta = baseKey.length - rawKey.length;
    if (delta < 2 || delta > 2) continue;
    if (isDeletionDistanceAtMost(rawKey, baseKey, 2)) candidates.push(item);
    if (candidates.length > 1) return null;
  }
  return candidates.length === 1 ? candidates[0] : null;
}

function isDeletionDistanceAtMost(shorter, longer, maxDeletes) {
  if (longer.length <= shorter.length || longer.length - shorter.length > maxDeletes) return false;
  let i = 0, j = 0, deletes = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i++; j++;
    } else {
      deletes++;
      j++;
      if (deletes > maxDeletes) return false;
    }
  }
  deletes += longer.length - j;
  return deletes <= maxDeletes;
}

function findDirectMatch(raw, byName, byCode, byLearning, byWeakName, byNameLength) {
  const learned = byLearning.get(matchKey(raw));
  if (learned) return { type: 'match', item: learned, mode: 'learned', score: 1 };
  const businessCode = extractBusinessCode(raw);
  if (businessCode && byCode.has(businessCode)) return { type: 'match', item: byCode.get(businessCode), mode: 'businessCode', score: 1 };
  const key = matchKey(raw);
  if (key && byName.has(key)) return { type: 'match', item: byName.get(key), mode: 'exact', score: 1 };
  const omission = findUniqueOneCharOmissionMatch(raw, byName, byNameLength);
  if (omission) return { type: 'match', item: omission, mode: 'similarity', score: 0.995 };
  const insertion = findUniqueOneCharInsertionMatch(raw, byNameLength);
  if (insertion) return { type: 'match', item: insertion, mode: 'similarity', score: 0.995 };
  const substitution = findUniqueOneCharSubstitutionMatch(raw, byNameLength);
  if (substitution) return { type: 'match', item: substitution, mode: 'similarity', score: 0.99 };
  const shortOmission = findUniqueShortOmissionMatch(raw, byName, byNameLength);
  if (shortOmission) return { type: 'match', item: shortOmission, mode: 'similarity', score: 0.985 };
  const weakKey = weakMatchKey(raw);
  const weakCandidate = weakKey ? byWeakName.get(weakKey) : null;
  if (weakCandidate) return { type: 'match', item: weakCandidate, mode: 'exact', score: 0.99 };
  return null;
}

function findMatch(raw, byName, byCode, used, byLearning, byWeakName, byNameLength, byNgram, similarityCache, keyFeatureCache) {
  const direct = findDirectMatch(raw, byName, byCode, byLearning, byWeakName, byNameLength);
  if (direct && !used.has(direct.item.index)) return direct;

  const businessCode = extractBusinessCode(raw);
  if (businessCode) {
    const candidate = byCode.get(businessCode);
    if (candidate && !used.has(candidate.index)) {
      return { type: 'match', item: candidate, mode: 'businessCode', score: 1 };
    }
  }

  const weakKey = weakMatchKey(raw);
  const weakCandidate = weakKey ? byWeakName.get(weakKey) : null;
  if (weakCandidate && !used.has(weakCandidate.index)) {
    return { type: 'match', item: weakCandidate, mode: 'exact', score: 0.99 };
  }

  const cacheKey = matchKey(raw);
  let cached = cacheKey ? similarityCache.get(cacheKey) : null;
  if (!cached) {
    const candidates = collectSimilarityCandidates(raw, byNameLength, byNgram);
    const scores = new Map();
    const rawFeatures = getRawMatchFeatures(raw, keyFeatureCache);
    const orderedCandidates = orderSimilarityCandidates(rawFeatures, candidates);
    let bestScore = 0;
    for (const entry of orderedCandidates) {
      const item = entry.item;
      const baseMeta = entry.meta;
      const nonEdit = entry.nonEdit;
      const cheap = entry.cheap;
      // edit 相似度的最大值为 1，因此 cheap 是最终分数的安全上界。
      // 只有在当前最佳分数已经更高时才跳过 Levenshtein，保证结果不变。
      if (bestScore >= 0.84 && cheap <= bestScore) continue;

      // 当当前最佳已经达到“直接匹配”阈值时，先用有界 Levenshtein 判断：
      // 如果候选的编辑距离连超过当前最佳分数都做不到，就不再执行完整 DP。
      // 低于 0.84 时仍走原始精确计算，避免影响 review / margin 判定。
      let score;
      if (bestScore >= 0.84) {
        if (canSimilarityBeatBest(rawFeatures.key, baseMeta, nonEdit, bestScore)) {
          score = similarityFromParts(rawFeatures, baseMeta, nonEdit);
        } else {
          continue;
        }
      } else {
        score = similarityFromParts(rawFeatures, baseMeta, nonEdit);
      }
      scores.set(item.index, score);
      if (score > bestScore) bestScore = score;
    }
    cached = { candidates, scores };
    if (cacheKey) similarityCache.set(cacheKey, cached);
  }
  let best = null;
  const alternatives = [];
  for (const item of cached.candidates) {
    if (used.has(item.index)) continue;
    const score = cached.scores.get(item.index) ?? 0;
    if (!best || score > best.score) best = { item, score };
    if (score > 0.56) {
      alternatives.push({ item, score });
      alternatives.sort((a, b) => b.score - a.score);
      if (alternatives.length > 3) alternatives.pop();
    }
  }
  if (!best) return { type: 'new', score: 0 };

  const margin = alternatives.length > 1 ? best.score - alternatives[1].score : best.score;
  if (best.score >= 0.84 || (best.score >= 0.76 && margin >= 0.045) || (best.score >= 0.70 && margin >= 0.10)) {
    return { type: 'match', item: best.item, mode: 'similarity', score: best.score };
  }
  if (best.score >= 0.56) {
    return {
      type: 'review',
      item: best.item,
      score: best.score,
      alternatives: alternatives.map(candidate => candidate.item)
    };
  }
  return { type: 'new', score: best.score };
}

const baseMatchMeta = new WeakMap();
function getBaseMatchMeta(item) {
  let meta = baseMatchMeta.get(item);
  if (meta) return meta;
  const names = getBaseMatchNames(item);
  const keys = names.map(matchKey).filter(Boolean);
  const stableKeys = [...new Set(names.map(stableStoreKey).filter(Boolean))];
  const tokenSets = keys.map(value => meaningfulTokens(value));
  const ngramSets = keys.map(value => ngramSet(value, 2));
  meta = {
    key: keys[0] || '',
    keys,
    businessCodes: [...new Set(names.map(extractBusinessCode).filter(Boolean))],
    stableKeys,
    stableKeySet: new Set(stableKeys),
    ngramSets,
    tokenSets
  };
  baseMatchMeta.set(item, meta);
  return meta;
}

function collectSimilarityCandidates(raw, byNameLength, byNgram) {
  const key = matchKey(raw);
  if (!key) return [];
  const selected = new Set();
  const minLength = Math.max(1, key.length - 2);
  const maxLength = key.length + 2;
  for (let length = minLength; length <= maxLength; length++) {
    for (const item of byNameLength.get(length) || []) selected.add(item);
  }
  if (key.length >= 8 && byNgram?.size) {
    const grams = [...ngramSet(key, 2)];
    if (grams.length >= 2) {
      const gramHits = new Map();
      for (const gram of grams) {
        for (const item of byNgram.get(gram) || []) {
          if (selected.has(item)) gramHits.set(item, (gramHits.get(item) || 0) + 1);
        }
      }
      const minimumHits = Math.max(2, Math.ceil(grams.length * 0.18));
      const narrowed = [...gramHits.entries()]
        .filter(([, hits]) => hits >= minimumHits)
        .sort((a, b) => b[1] - a[1])
        .map(([item]) => item);
      if (narrowed.length) return narrowed;
    }
  }
  return [...selected];
}

function orderSimilarityCandidates(features, candidates) {
  const ranked = candidates.map((item, index) => {
    const meta = getBaseMatchMeta(item);
    const nonEdit = getNonEditSimilarityFromMeta(features, meta);
    const cheap = 0.38 + nonEdit.ngram * 0.34 + nonEdit.token * 0.20 + nonEdit.containment * 0.08;
    return { item, meta, nonEdit, cheap, index };
  });
  if (ranked.length > 1) ranked.sort((a, b) => b.cheap - a.cheap || a.index - b.index);
  return ranked;
}

function storeSimilarity(a, b) {
  return storeSimilarityFromMeta(a, getBaseMatchMeta(b));
}

function storeSimilarityFromMeta(a, bm, keyFeatureCache) {
  const features = getRawMatchFeatures(a, keyFeatureCache);
  if (!features.key || !bm.key) return 0;
  if (bm.keys.includes(features.key)) return 1;
  if (features.businessCode && bm.businessCodes.includes(features.businessCode)) return 1;

  const nonEdit = getNonEditSimilarityFromMeta(features, bm);
  return similarityFromParts(features, bm, nonEdit);
}

function getNonEditSimilarityFromMeta(features, bm) {
  let ngram = 0, token = 0, containment = 0;
  for (let index = 0; index < bm.keys.length; index++) {
    const key = bm.keys[index];
    ngram = Math.max(ngram, characterNgramSimilarityFromSets(features.ngrams, bm.ngramSets[index]));
    token = Math.max(token, tokenOverlapFromSets(features.tokens, bm.tokenSets[index]));
    if (key.includes(features.key) || features.key.includes(key)) {
      containment = Math.max(containment, Math.min(features.key.length, key.length) / Math.max(features.key.length, key.length));
    }
  }
  return { ngram, token, containment };
}

function similarityFromParts(features, bm, nonEdit) {
  let edit = 0;
  for (const key of bm.keys) {
    edit = Math.max(edit, normalizedEditSimilarity(features.key, key));
  }
  return Math.min(1, edit * 0.38 + nonEdit.ngram * 0.34 + nonEdit.token * 0.20 + nonEdit.containment * 0.08);
}

// 仅用于 bestScore >= 0.84 的安全剪枝。
// 若任何基准名称的编辑距离有机会让最终分数严格超过当前最佳，才进入完整精确计算。
// 返回 false 表示该候选不可能成为新的最佳项。
function canSimilarityBeatBest(rawKey, bm, nonEdit, bestScore) {
  const nonEditScore = nonEdit.ngram * 0.34 + nonEdit.token * 0.20 + nonEdit.containment * 0.08;
  const requiredEditSimilarity = (bestScore - nonEditScore) / 0.38;
  if (requiredEditSimilarity <= 0) return true;
  if (requiredEditSimilarity >= 1) return false;

  // bm.keys 可能包含不同长度的名称变体；每个 key 必须使用自己的长度计算
  // 编辑距离上界，不能统一使用 bm.key，否则可能错误剪枝。
  for (const key of bm.keys) {
    const maxLen = Math.max(rawKey.length, key.length);
    const strictDistanceLimit = (1 - requiredEditSimilarity) * maxLen;
    const maxDistance = Math.ceil(strictDistanceLimit - 1e-12) - 1;
    if (maxDistance < 0) continue;

    // 长度差本身已经超过允许编辑距离时，无需进入 DP。
    if (Math.abs(rawKey.length - key.length) > maxDistance) continue;
    if (levenshteinAtMost(rawKey, key, maxDistance) !== null) return true;
  }
  return false;
}

// 返回精确编辑距离；若确认距离超过 maxDistance，则提前结束。
// 通过按长度交换两端并限制 DP 带宽，避免对明显不可能超过当前最佳的候选构建完整矩阵。
function levenshteinAtMost(a, b, maxDistance) {
  const aa = String(a || ''), bb = String(b || '');
  if (aa === bb) return 0;
  if (!Number.isFinite(maxDistance)) return normalizedEditDistance(aa, bb);
  maxDistance = Math.max(0, Math.floor(maxDistance));
  if (!aa.length) return bb.length <= maxDistance ? bb.length : null;
  if (!bb.length) return aa.length <= maxDistance ? aa.length : null;
  if (Math.abs(aa.length - bb.length) > maxDistance) return null;

  // 两行数组复用；每轮只写有效带区及两侧哨兵，减少重复内存分配。
  let rows = aa, cols = bb;
  if (cols.length > rows.length) [rows, cols] = [cols, rows];

  const width = cols.length;
  const sentinel = maxDistance + 1;
  let previous = new Array(width + 1).fill(sentinel);
  let current = new Array(width + 1).fill(sentinel);
  for (let j = 0; j <= width; j++) previous[j] = j;

  for (let i = 1; i <= rows.length; i++) {
    const from = Math.max(1, i - maxDistance);
    const to = Math.min(width, i + maxDistance);
    current[0] = i;
    if (from > 1) current[from - 1] = sentinel;

    let rowMin = current[0];
    for (let j = from; j <= to; j++) {
      const insert = current[j - 1] + 1;
      const remove = previous[j] + 1;
      const replace = previous[j - 1] + (rows[i - 1] === cols[j - 1] ? 0 : 1);
      const value = Math.min(insert, remove, replace);
      current[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (to < width) current[to + 1] = sentinel;

    if (rowMin > maxDistance) return null;
    [previous, current] = [current, previous];
  }
  return previous[width] <= maxDistance ? previous[width] : null;
}

function cheapSimilarityUpperBound(features, bm) {
  if (!features.key || !bm.key) return 0;
  if (bm.keys.includes(features.key)) return 1;
  if (features.businessCode && bm.businessCodes.includes(features.businessCode)) return 1;
  let ngram = 0, token = 0, containment = 0;
  for (let index = 0; index < bm.keys.length; index++) {
    ngram = Math.max(ngram, characterNgramSimilarityFromSets(features.ngrams, bm.ngramSets[index]));
    token = Math.max(token, tokenOverlapFromSets(features.tokens, bm.tokenSets[index]));
    const key = bm.keys[index];
    if (key.includes(features.key) || features.key.includes(key)) {
      containment = Math.max(containment, Math.min(features.key.length, key.length) / Math.max(features.key.length, key.length));
    }
  }
  return 0.38 + ngram * 0.34 + token * 0.20 + containment * 0.08;
}

function getRawMatchFeatures(value, cache) {
  const key = matchKey(value);
  if (!key) return { key: '', businessCode: '', tokens: new Set(), ngrams: new Set() };
  const cached = cache?.get(key);
  if (cached) return cached;
  const features = {
    key,
    businessCode: extractBusinessCode(value),
    tokens: meaningfulTokens(key),
    ngrams: ngramSet(key, 2)
  };
  cache?.set(key, features);
  return features;
}

function tokenOverlapFromSets(a, b) {
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common++;
  return common / Math.max(a.size, b.size);
}

function weakMatchKey(value) {
  return matchKey(value).replace(/^(?:i|ii)类/, '');
}

function stableStoreKey(value) { return matchKey(value).replace(/^(?:渝北|江北|特渠部|天友加盟|天友24h)/, ''); }
function tokenOverlap(a, b) { const aa = meaningfulTokens(a), bb = meaningfulTokens(b); if (!aa.size || !bb.size) return 0; let common = 0; for (const token of aa) if (bb.has(token)) common++; return common / Math.max(aa.size, bb.size); }
function meaningfulTokens(value) { const set = new Set(); for (const token of matchKey(value).match(/[a-z]+|\d+|[\u4e00-\u9fff]+/g) || []) if (token.length >= 2 || /\d/.test(token) || /[a-z]/i.test(token)) set.add(token); return set; }
function characterNgramSimilarity(a, b, n = 2) { return characterNgramSimilarityFromSets(ngramSet(a, n), ngramSet(b, n)); }
function characterNgramSimilarityFromSets(a, b) { if (!a?.size || !b?.size) return 0; let common = 0; for (const value of a) if (b.has(value)) common++; return (2 * common) / (a.size + b.size); }
function ngramSet(value, n) { const text = String(value || ''); const set = new Set(); if (text.length <= n) { if (text) set.add(text); return set; } for (let i = 0; i <= text.length - n; i++) set.add(text.slice(i, i + n)); return set; }
function normalizedEditSimilarity(a, b) { const aa = String(a || ''), bb = String(b || ''); if (aa === bb) return 1; if (!aa || !bb) return 0; return 1 - levenshtein(aa, bb) / Math.max(aa.length, bb.length); }
function levenshtein(a, b) { if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length; let previous = Array.from({ length: b.length + 1 }, (_, i) => i); for (let i = 1; i <= a.length; i++) { const current = [i]; for (let j = 1; j <= b.length; j++) { const cost = a[i - 1] === b[j - 1] ? 0 : 1; current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost); } previous = current; } return previous[b.length]; }

function getBaseMatchNames(item) {
  if (!item || typeof item !== 'object') return item ? [String(item)] : [];
  const values = [
    item.name, item.storeName, item.title, item.customerName, item['门店名称'],
    item.originalName, item.displayName, item['原始名称'], item['显示名称'],
    ...(Array.isArray(item.aliases) ? item.aliases : []),
    ...(Array.isArray(item.aliasNames) ? item.aliasNames : [])
  ];
  return [...new Set(values.map(value => cleanStoreName(value)).filter(Boolean))];
}

function normalizeBase(store, index) {
  if (typeof store === 'string') return { name: cleanStoreName(store), code: String(index + 1).padStart(2, '0'), index };
  if (!store) return null;
  const name = cleanStoreName(store.name || store.storeName || store.title || store.customerName || store['门店名称'] || store.originalName || store.displayName || '');
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
    .replace(/[∥〢丨]/g, 'II')
    // OCR可能把罗马数字 II 后的“类”识别成类似小写 l；仅在“II/l + 类”结构中做通用归一化。
    .replace(/((?:ii|iii|iv|v|vi|vii|viii|ix|x))l(?=类)/gi, '$1')
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
