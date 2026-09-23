// 天友智配One - 用户独立运单确认入库 API
import { authRequired } from './_auth.js';
import { canUseRoute, legacyUserOrderKey, listUsersByRoute, loadRouteBase, normalizeRoute, routeBaseKey, routeLearningKey, routeOrderKey } from './_data.js';

const REDIS_TIMEOUT_MS = 4000;
const ORDER_LOCK_TTL_SECONDS = 60;

export async function onRequest({ request, env }) {
  let stage = 'start';
  try {
    if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
    stage = 'auth';
    const session = await authRequired(request, env, { allowAnyRoute: true });
    if (!session?.id) return json({ success: false, error: '登录已失效或权限信息不完整', stage }, 401);
    if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: 'Redis not configured', stage }, 500);

    stage = 'request-body';
    const body = await request.json().catch(() => ({}));
    const route = normalizeRoute(body.route || session.route);
    const userId = normalizeUserId(session.id);
    if (!canUseRoute(session.user || session, route)) return json({ success: false, error: '无权使用该路线', stage }, 403);
    if (!Array.isArray(body.orders) || !body.orders.length) return json({ success: false, error: '没有可确认的订单' }, 400);

    const pending = body.orders.filter(item => item?.needsReview === true || item?.matchType === 'review' || String(item?.candidate || '').trim());
    if (pending.length) return json({
      success: false,
      code: 'REVIEW_REQUIRED',
      error: `仍有 ${pending.length} 家疑似门店未确认`,
      review: pending.map(item => ({ name: item?.name || '', candidate: item?.candidate || '', matchScore: Number(item?.matchScore) || 0 }))
    }, 409);

    const date = normalizeDate(body.date) || businessDate();
    const noBase = body.baseDatabaseAvailable === false;
    stage = noBase ? 'prepare-without-base' : 'load-base';
    const base = noBase ? [] : await loadBase(env, route, userId, session.boundRouteId);
    const inputCount = body.orders.length;
    const canonical = noBase ? canonicalizeRawOrders(body.orders) : canonicalizeOrders(body.orders, base);
    const duplicateCount = countDuplicates(canonical);
    const uniqueCanonical = dedupeCanonical(canonical);
    const orderBatchId = String(body.orderBatchId || '').trim() || createBatchId(date, route);
    const confirmRequestId = String(body.confirmRequestId || '').trim().slice(0, 160);
    const idempotencyKey = confirmRequestId ? routeOrderKey(route, `confirm:${date}:${confirmRequestId}`) : '';
    const normalized = uniqueCanonical.map((item, index) => normalizeOrder(item, index, orderBatchId, date, route));
    const orders = noBase ? normalizeRawOrderList(normalized) : sortOrders(normalized, base);
    const totalWeight = resolveTotalWeight(body.totalWeight ?? body.weight, body.rawText);
    if (!totalWeight) return json({ success: false, code: 'WEIGHT_MISSING', error: '未识别到商品总量，请重新解析后再确认' }, 422);

    const rawOrderCount = positiveInt(body.rawOrderCount) || positiveInt(body.recognizedCount) || inputCount;
    const now = new Date().toISOString();
    const todayData = {
      orderBatchId, date, route, userId,
      vehicle: String(body.vehicle || '').trim() || session.vehicle || '',
      orders, totalWeight,
      count: orders.length,
      uniqueStoreCount: orders.length,
      matchedCount: noBase ? 0 : orders.filter(item => item.matched).length,
      newStoreCount: noBase ? 0 : orders.filter(item => item.isNew).length,
      reviewCount: 0,
      duplicateCount: Math.max(Number(body.duplicateCount) || 0, duplicateCount),
      recognizedCount: positiveInt(body.recognizedCount) || rawOrderCount,
      rawOrderCount,
      baseDatabaseAvailable: !noBase,
      source: String(body.source || 'web-confirm'),
      updatedAt: now
    };

    stage = 'build-order-data';
    const todayKey = routeOrderKey(route, `today:${date}`);
    const lockKey = routeOrderKey(route, `lock:${date}`);
    const token = createLockToken();
    stage = 'acquire-lock';
    if (!(await acquireLock(env, lockKey, token, ORDER_LOCK_TTL_SECONDS))) return json({ success: false, error: '当前线路正在保存订单，请稍后再试', stage }, 409);
    try {
      if (idempotencyKey) {
        const prior = await redisGet(env, idempotencyKey);
        if (prior?.orderBatchId) {
          const priorData = await findHistoryBatch(env, userId, route, date, prior.orderBatchId, session.boundRouteId);
          if (priorData) return json({ success: true, duplicate: true, idempotent: true, data: priorData });
        }
      }
      // 重复运单必须在日期锁内判断，避免两个相同确认请求并发穿透。
      // 命中后直接复用第一笔已有批次，不覆盖今日数据、不新增历史记录。
      stage = 'duplicate-check';
      const duplicate = await findDuplicateOrder(env, userId, route, date, todayData, session.boundRouteId);
      if (duplicate) {
        stage = 'duplicate-history';
        const duplicateLatest = {
          date,
          orderBatchId: duplicate.orderBatchId,
          updatedAt: duplicate.updatedAt || new Date().toISOString()
        };
        await saveHistoryAndLatest(env, userId, route, date, duplicate, duplicateLatest);
        if (idempotencyKey) await saveIdempotency(env, idempotencyKey, duplicate.orderBatchId).catch(error => console.warn('确认幂等索引写入失败', error));
        return json({ success: true, duplicate: true, data: duplicate });
      }

      // Redis SET 成功响应即表示命令已执行，不再额外 GET 三次验证，避免确认录入长时间等待。
      const saved = todayData;
      const historyKey = routeOrderKey(route, `history:${date}`);
      stage = 'prepare-history';
      const oldHistory = await redisGet(env, historyKey);
      const list = Array.isArray(oldHistory) ? oldHistory : [];
      const record = {
        orderBatchId: saved.orderBatchId, date, route, userId, vehicle: saved.vehicle,
        count: saved.count, uniqueStoreCount: saved.uniqueStoreCount ?? saved.count,
        weight: saved.totalWeight, totalWeight: saved.totalWeight, orders: saved.orders,
        matchedCount: saved.matchedCount, newStoreCount: saved.newStoreCount, reviewCount: 0,
        duplicateCount: saved.duplicateCount || 0, recognizedCount: saved.recognizedCount,
        rawOrderCount: saved.rawOrderCount, baseDatabaseAvailable: saved.baseDatabaseAvailable !== false,
        source: saved.source, updatedAt: saved.updatedAt
      };
      const signature = historySignature(record);
      const index = list.findIndex(item => historySignature(item) === signature);
      if (index >= 0) list[index] = record;
      else list.push(record);
      list.sort((x, y) => String(y?.updatedAt || '').localeCompare(String(x?.updatedAt || '')));
      const historyPayload = list.slice(0, 90);

      // 今日订单和历史记录必须一次提交，避免出现“今日有数据、历史没记录”的半成功状态。
      stage = 'write-order-history';
      const writeResult = await redisTransaction(env, [
        ['SET', todayKey, JSON.stringify(todayData)],
        ['SET', historyKey, JSON.stringify(historyPayload)],
        ['SET', routeOrderKey(route, 'latest'), JSON.stringify({ date, orderBatchId, updatedAt: saved.updatedAt })]
      ]);
      if (!Array.isArray(writeResult) || writeResult.length !== 3 || writeResult.some(item => item && item.error)) {
        throw new Error('今日订单与历史记录写入未完成');
      }

      // 返回成功前同时核验今日与历史，保证“确认成功”与两份核心数据一致。
      stage = 'verify-order-history';
      const [savedToday, savedHistory] = await redisPipelineGet(env, [todayKey, historyKey]);
      const historyExists = Array.isArray(savedHistory) && savedHistory.some(item => String(item?.orderBatchId || '') === String(orderBatchId));
      if (savedToday?.orderBatchId !== orderBatchId || !Array.isArray(savedToday?.orders) || !historyExists) {
        throw new Error('订单已写入但今日/历史数据核验未通过，请重试');
      }
      if (idempotencyKey) await saveIdempotency(env, idempotencyKey, orderBatchId).catch(error => console.warn('确认幂等索引写入失败', error));

      // 门店学习由前端 /api/store-learning 独立执行，不能阻断核心入库链路。
      return json({ success: true, data: saved });
        } finally {
      // 锁只用于并发保护；释放失败不应让已经成功写入的订单变成“确认失败”。
      releaseLock(env, lockKey, token).catch(() => {});
    }
  } catch (error) {
    console.error('confirm api error', { stage, error });
    return json({ success: false, error: error?.message || '确认入库失败', stage }, 503);
  }
}

async function loadBase(env, route, userId, boundRouteId) {
  const raw = await loadRouteBase(env, route, { allowLegacyUserId: normalizeRoute(boundRouteId) === normalizeRoute(route) ? userId : undefined });
  const stores = Array.isArray(raw?.stores) ? raw.stores : [];
  if (!stores.length) throw new Error(`未找到${route}路线基准数据库`);
  return stores.map((store, index) => ({
    name: String(store?.name || store?.storeName || store?.shopName || store?.['门店名称'] || '').trim(),
    code: String(store?.code || index + 1).padStart(2, '0'),
    nav: String(store?.nav || store?.navigation || store?.url || store?.['导航'] || '').trim(),
    note: String(store?.note || store?.['备注'] || '').trim(),
    routeOrder: Number(store?.routeOrder || store?.code || index + 1) || index + 1,
    index
  })).filter(store => store.name);
}

function canonicalizeRawOrders(input) {
  return input.map(item => {
    const raw = typeof item === 'string' ? { name: item } : (item || {});
    const name = String(raw.name || raw.storeName || raw.shopName || raw['门店名称'] || '').trim();
    return { ...raw, name, code: '', nav: String(raw.nav || '').trim(), note: String(raw.note || '').trim(), matched: false, isNew: false, needsReview: false, candidate: '', candidates: [], matchType: 'raw-order', matchScore: 0, _baseIndex: null };
  }).filter(item => item.name);
}

function canonicalizeOrders(input, base) {
  const byName = new Map(base.map(store => [key(store.name), store]));
  const byCode = new Map(base.map(store => [String(store.code), store]));
  return input.map(item => {
    const raw = typeof item === 'string' ? { name: item } : (item || {});
    const name = String(raw.name || raw.storeName || raw.shopName || raw['门店名称'] || '').trim();
    const parserMatched = raw.matched === true && raw.isNew !== true && raw.needsReview !== true;
    const parserNew = raw.isNew === true || raw.newStore === true;
    const hit = byName.get(key(name)) || byCode.get(String(raw.baseCode || raw.code || ''));
    if (parserMatched) return { ...raw, name: hit?.name || name, code: hit?.code || raw.code || '', nav: hit?.nav || raw.nav || '', note: hit?.note || raw.note || '', matched: true, isNew: false, needsReview: false, candidate: '', matchType: raw.matchType || 'confirmed', matchScore: Number(raw.matchScore) || 1, _baseIndex: hit?.index };
    if (parserNew) return { ...raw, name, matched: false, isNew: true, needsReview: false, candidate: '', matchType: 'new', _baseIndex: null };
    if (hit) return { ...raw, name: hit.name, code: hit.code, nav: hit.nav || raw.nav || '', note: hit.note || raw.note || '', matched: true, isNew: false, needsReview: false, candidate: '', matchType: 'confirmed', matchScore: 1, _baseIndex: hit.index };
    return { ...raw, name, matched: false, isNew: true, needsReview: false, candidate: '', matchType: 'new', _baseIndex: null };
  }).filter(item => item.name);
}

function dedupeCanonical(items) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    const identity = item._baseIndex != null ? `b:${item._baseIndex}` : `n:${key(item.name)}`;
    if (!key(item.name) || seen.has(identity)) continue;
    seen.add(identity);
    output.push(item);
  }
  return output;
}

function countDuplicates(items) {
  const seen = new Set();
  let count = 0;
  for (const item of items) {
    const identity = item._baseIndex != null ? `b:${item._baseIndex}` : `n:${key(item.name)}`;
    if (seen.has(identity)) count++;
    else seen.add(identity);
  }
  return count;
}

function sortOrders(orders, base) {
  const rank = new Map(base.map((store, index) => [store.index, Number(store.routeOrder) || index + 1]));
  const matched = [];
  const news = [];
  for (const item of orders) {
    const routeOrder = item._baseIndex != null ? rank.get(item._baseIndex) : null;
    if (routeOrder == null && item.matched !== true) news.push({ ...item, isNew: true, matched: false });
    else matched.push({ ...item, routeOrder: routeOrder ?? Number.MAX_SAFE_INTEGER, isNew: false, matched: true });
  }
  matched.sort((a, b) => a.routeOrder - b.routeOrder);
  matched.forEach((item, index) => { item.code = String(index + 1).padStart(2, '0'); });
  news.forEach((item, index) => { item.code = `N${String(index + 1).padStart(2, '0')}`; });
  return matched.concat(news).map(({ routeOrder, _baseIndex, ...item }) => item);
}

function normalizeRawOrderList(orders) {
  return orders.map((item, index) => ({ ...item, code: String(index + 1).padStart(2, '0'), matched: false, isNew: false, matchType: 'raw-order' }));
}

function normalizeOrder(item, index, batchId, date, route) {
  return {
    id: String(item.id || `${batchId}-${index + 1}`),
    orderBatchId: batchId,
    code: String(item.code || index + 1).padStart(2, '0'),
    name: String(item.name || '').trim(),
    nav: String(item.nav || '').trim(),
    weight: Number(item.weight) || 0,
    note: String(item.note || '').trim(),
    matched: item.matched === true,
    isNew: item.isNew === true,
    status: String(item.status || '待配送'),
    route, date,
    matchType: String(item.matchType || '').trim()
  };
}

async function learnConfirmedVariants(env, userId, route, inputOrders, base) {
  const learningKey = scopedLearningKey(userId, route);
  const lockKey = scopedLearningKey(userId, route, 'lock');
  const token = createLockToken();
  if (!(await acquireLock(env, lockKey, token, 10))) return;
  try {
    const learning = await getLearning(env, learningKey);
    learning.version = 4;
    learning.userId = userId;
    learning.route = route;
    learning.aliases = learning.aliases && typeof learning.aliases === 'object' ? learning.aliases : {};
    const byName = new Map(base.map(store => [key(store.name), store]));
    const byCode = new Map(base.map(store => [String(store.code), store]));
    const now = new Date().toISOString();
    for (const rawItem of inputOrders) {
      const raw = typeof rawItem === 'string' ? { name: rawItem } : (rawItem || {});
      if (raw.isNew === true || raw.newStore === true || raw.needsReview === true || raw.matchType === 'review') continue;
      const rawName = String(raw.name || raw.storeName || raw.shopName || raw['门店名称'] || '').trim();
      if (!rawName) continue;
      const target = byName.get(key(rawName)) || byCode.get(cleanCode(raw.baseCode || raw.code));
      const baseName = String(raw.baseName || raw.canonicalName || target?.name || '').trim();
      if (!baseName || key(rawName) === key(baseName)) continue;
      const targetStore = target || base.find(store => key(store.name) === key(baseName));
      if (!targetStore) continue;
      const aliasKey = key(rawName);
      const previous = learning.aliases[aliasKey];
      const examples = Array.isArray(previous?.rawExamples) ? previous.rawExamples.filter(Boolean) : [];
      if (!examples.includes(rawName)) examples.push(rawName);
      learning.aliases[aliasKey] = { baseKey: key(targetStore.name), baseCode: String(targetStore.code || ''), baseName: targetStore.name, count: Math.max(1, Number(previous?.count) || 0) + 1, firstSeenAt: previous?.firstSeenAt || now, updatedAt: now, rawExamples: examples.slice(-3) };
    }
    pruneAliases(learning.aliases, 1000);
    learning.updatedAt = now;
    await redisSet(env, learningKey, learning);
  } finally {
    await releaseLock(env, lockKey, token).catch(() => {});
  }
}

async function findDuplicateOrder(env, userId, route, date, candidate, boundRouteId) {
  const todayKey = routeOrderKey(route, `today:${date}`);
  const historyKey = routeOrderKey(route, `history:${date}`);
  let [today, history] = await redisPipelineGet(env, [todayKey, historyKey]);
  if (normalizeRoute(boundRouteId) === normalizeRoute(route)) {
    if (!today) today = await redisGet(env, legacyUserOrderKey(userId, route, `today:${date}`));
    if (!Array.isArray(history) || !history.length) {
      const users = await listUsersByRoute(env, route);
      const legacyLists = await Promise.all(users.map(async user => {
        const legacy = await redisGet(env, legacyUserOrderKey(user.id, route, `history:${date}`));
        return Array.isArray(legacy) ? legacy : [];
      }));
      history = legacyLists.flat();
    }
  }
  if (businessOrderSignature(today) && businessOrderSignature(today) === businessOrderSignature(candidate)) return today;
  if (Array.isArray(history)) {
    const signature = businessOrderSignature(candidate);
    if (signature) {
      const match = history.filter(item => businessOrderSignature(item) === signature)
        .sort((x, y) => String(y?.updatedAt || '').localeCompare(String(x?.updatedAt || '')))[0];
      if (match) return match;
    }
  }
  return null;
}

async function saveHistoryAndLatest(env, userId, route, date, today, latest) {
  const historyKey = routeOrderKey(route, `history:${date}`);
  const latestKey = routeOrderKey(route, 'latest');
  let old = await redisGet(env, historyKey);
  const list = Array.isArray(old) ? old : [];
  const record = {
    orderBatchId: today.orderBatchId, date, route, userId, vehicle: today.vehicle,
    count: today.count, uniqueStoreCount: today.uniqueStoreCount ?? today.count,
    weight: today.totalWeight, totalWeight: today.totalWeight, orders: today.orders,
    matchedCount: today.matchedCount, newStoreCount: today.newStoreCount, reviewCount: 0,
    duplicateCount: today.duplicateCount || 0, recognizedCount: today.recognizedCount,
    rawOrderCount: today.rawOrderCount, baseDatabaseAvailable: today.baseDatabaseAvailable !== false,
    source: today.source, updatedAt: today.updatedAt
  };
  const signature = historySignature(record);
  const index = list.findIndex(item => historySignature(item) === signature);
  if (index >= 0) list[index] = record;
  else list.push(record);
  list.sort((x, y) => String(y?.updatedAt || '').localeCompare(String(x?.updatedAt || '')));
  const payload = list.slice(0, 90);
  const result = await redisTransaction(env, [
    ['SET', historyKey, JSON.stringify(payload)],
    ['SET', latestKey, JSON.stringify(latest)]
  ]);
  if (!Array.isArray(result) || result.length !== 2 || result.some(item => item && item.error)) {
    throw new Error('重复订单历史与索引写入未完成');
  }
}

async function saveHistory(env, userId, route, date, today) {
  const keyName = routeOrderKey(route, `history:${date}`);
  let old = null;
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      old = await redisGet(env, keyName);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 120));
    }
  }
  if (lastError) throw lastError;
  const list = Array.isArray(old) ? old : [];
  const record = {
    orderBatchId: today.orderBatchId, date, route, userId, vehicle: today.vehicle,
    count: today.count, uniqueStoreCount: today.uniqueStoreCount ?? today.count,
    weight: today.totalWeight, totalWeight: today.totalWeight, orders: today.orders,
    matchedCount: today.matchedCount, newStoreCount: today.newStoreCount, reviewCount: 0,
    duplicateCount: today.duplicateCount || 0, recognizedCount: today.recognizedCount,
    rawOrderCount: today.rawOrderCount, baseDatabaseAvailable: today.baseDatabaseAvailable !== false,
    source: today.source, updatedAt: today.updatedAt
  };
  const signature = historySignature(record);
  const index = list.findIndex(item => historySignature(item) === signature);
  if (index >= 0) list[index] = record;
  else list.push(record);
  list.sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')));
  let saveError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await redisSet(env, keyName, list.slice(0, 90));
      saveError = null;
      break;
    } catch (error) {
      saveError = error;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 120));
    }
  }
  if (saveError) throw saveError;
}

async function getLearning(env, keyName) {
  const data = await redisGet(env, keyName);
  if (!data || typeof data !== 'object') return { version: 4, aliases: {} };
  return { ...data, aliases: data.aliases && typeof data.aliases === 'object' ? data.aliases : {} };
}

function scopedBaseKey(userId, route) { return routeBaseKey(route); }
function scopedLearningKey(userId, route, suffix = '') { return `${routeLearningKey(route)}${suffix ? `:${suffix}` : ''}`; }
function encodeKey(value) { return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_'); }
function normalizeUserId(value) { return String(value || '').trim().slice(0, 128); }
function key(value) { return String(value || '').trim().replace(/[\s\u3000（）()【】\[\]{}]/g, '').replace(/谊品鲜/g, '谊品生鲜').replace(/客户中心/g, '客服中心').replace(/\b20\d{2}\b/g, '').replace(/临时/g, '').toLowerCase(); }
function cleanCode(value) { const text = String(value || '').trim(), match = text.match(/\d+/); return match ? String(Number(match[0])).padStart(2, '0') : text; }
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'), m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function historySignature(record) {
  const business = businessOrderSignature(record);
  if (business) return business;
  const batch = String(record?.orderBatchId || '').trim();
  if (batch) return `batch:${batch}`;
  const stores = Array.isArray(record?.orders) ? record.orders.map(item => key(item?.name)).filter(Boolean).sort() : [];
  return JSON.stringify({
    route: String(record?.route || ''),
    date: String(record?.date || ''),
    vehicle: String(record?.vehicle || ''),
    weight: normalizeWeight(record?.totalWeight ?? record?.weight),
    stores
  });
}
async function readAfterWrite(env, keyName, batchId, count) { for (let attempt = 0; attempt < 3; attempt++) { const saved = await redisGet(env, keyName); if (saved?.orderBatchId === batchId && Array.isArray(saved.orders) && saved.orders.length === count && normalizeWeight(saved.totalWeight)) return saved; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); } return null; }
function pruneAliases(aliases, limit) { const entries = Object.entries(aliases); if (entries.length <= limit) return; entries.sort((a, b) => String(a[1]?.updatedAt || '').localeCompare(String(b[1]?.updatedAt || ''))); for (const [alias] of entries.slice(0, entries.length - limit)) delete aliases[alias]; }
function createBatchId(date, route) { const stamp = new Date().toISOString().replace(/[-:.TZ]/g, ''); const suffix = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(0, 12); return `${date}-${route.replace(/\D/g, '')}-${stamp}-${suffix}`; }
function createLockToken() { return `${Date.now()}-${Math.random().toString(36).slice(2)}-${crypto.randomUUID?.() || ''}`; }
async function acquireLock(env, keyName, token, seconds) { const response = await redisFetch(env, `/set/${encodeURIComponent(keyName)}/${encodeURIComponent(token)}/NX/EX/${seconds}`, { method: 'POST' }); if (!response.ok) return false; const data = await response.json().catch(() => ({})); return data.result === 'OK'; }
async function releaseLock(env, keyName, token) { const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"; await redisFetch(env, '/eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([script, 1, keyName, token]) }); }
async function redisFetch(env, path, options = {}) { const base = String(env.UPSTASH_REDIS_REST_URL || '').trim().replace(/\/+$/, ''); if (!base) throw new Error('Redis URL 未配置'); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS); try { return await fetch(`${base}${path}`, { ...options, headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, ...(options.headers || {}) }, cache: 'no-store', signal: controller.signal }); } catch (error) { if (error?.name === 'AbortError') throw new Error('Redis 请求超时'); throw new Error(`Redis 网络请求失败：${error?.message || 'unknown error'}`); } finally { clearTimeout(timer); } }
async function redisTransaction(env, commands) {
  const response = await redisFetch(env, '/multi-exec', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error(`Redis事务失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => null);
  if (!Array.isArray(data)) {
    if (data?.error) throw new Error(String(data.error));
    throw new Error('Redis事务返回格式异常');
  }
  const failed = data.find(item => item && item.error);
  if (failed) throw new Error(String(failed.error));
  return data;
}

async function redisPipeline(env, commands) {
  const response = await redisFetch(env, '/pipeline', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(commands)
  });
  if (!response.ok) throw new Error(`Redis批量操作失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => []);
  if (!Array.isArray(data)) throw new Error('Redis批量操作返回格式异常');
  const failed = data.find(item => item && item.error);
  if (failed) throw new Error(String(failed.error));
  return data;
}
async function redisPipelineGet(env, keys) {
  const results = await redisPipeline(env, keys.map(keyName => ['GET', keyName]));
  return results.map(item => {
    const value = item?.result;
    if (value === null || value === undefined || value === '') return null;
    try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  });
}
async function redisGet(env, keyName) { const response = await redisFetch(env, `/get/${encodeURIComponent(keyName)}`); if (!response.ok) throw new Error(`Redis读取失败（HTTP ${response.status}）`); const data = await response.json().catch(() => ({})); if (data.result === null || data.result === undefined || data.result === '') return null; try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; } }
async function redisSet(env, keyName, value) { const response = await redisFetch(env, `/set/${encodeURIComponent(keyName)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); if (!response.ok) throw new Error(`Redis保存失败（HTTP ${response.status}）`); const data = await response.json().catch(() => ({})); if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认'); }
async function saveIdempotency(env, keyName, orderBatchId) { const response = await redisFetch(env, `/set/${encodeURIComponent(keyName)}/${encodeURIComponent(JSON.stringify({ orderBatchId }))}/EX/86400`, { method: 'POST' }); if (!response.ok) throw new Error(`幂等索引保存失败（HTTP ${response.status}）`); }
async function findHistoryBatch(env, userId, route, date, orderBatchId, boundRouteId) { const historyKey = routeOrderKey(route, `history:${date}`); let history = await redisGet(env, historyKey); if ((!Array.isArray(history) || !history.length) && normalizeRoute(boundRouteId) === normalizeRoute(route)) history = await redisGet(env, legacyUserOrderKey(userId, route, `history:${date}`)); if (!Array.isArray(history)) return null; return history.find(item => String(item?.orderBatchId || '') === String(orderBatchId)) || null; }
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' } }); }
