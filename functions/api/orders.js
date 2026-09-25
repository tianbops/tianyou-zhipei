// Zhipei One - 用户独立订单 API
// 订单按线路+日期统一存储，服务器为唯一真实数据源。
import { authRequired } from './_auth.js';
import { canUseRoute, getRoute, legacyUserOrderKey, listUsersByRoute, normalizeRoute, routeOrderKey } from './_data.js';

const REDIS_TIMEOUT_MS = 8000;
const ORDER_LOCK_TTL_SECONDS = 60;

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session?.id) return json({ error: '登录已失效或权限信息不完整' }, 401);
  try {
    if (request.method === 'POST') return await saveOrder(request, env, session);
    if (request.method === 'GET') return await readOrder(request, env, session);
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) {
    console.error('orders api error', error);
    return json({ success: false, error: '订单数据服务暂不可用', detail: error?.message || 'server error' }, 503);
  }
}

async function saveOrder(request, env, session) {
  const body = await request.json().catch(() => ({}));
  const route = normalizeRoute(body.route), userId = normalizeUserId(session.id);
  if (!route) return json({ error: '缺少调度线路' }, 400);
  if (!canUseRoute(session.user || session, route)) return json({ error: '无权使用该线路' }, 403);
  const routeRecord = await getRoute(env, route);
  if (!routeRecord || routeRecord.status === 'disabled') return json({ error: '当前线路不存在或已停用' }, 404);
  // /api/orders POST 仅保留“订单详情页更换车辆”这一增量写操作。
  // 正式运单录入统一由 /api/auto-plan 完成；本接口只允许订单详情页对已确认批次进行车辆更新。
  const source = String(body.source || '').trim();
  if (source !== 'order-detail') return json({ error: '订单录入请使用确认接口' }, 409);
  if (!String(body.orderBatchId || '').trim()) return json({ error: '缺少原订单批次，不能修改车辆' }, 400);
  if (!Array.isArray(body.orders) || !body.orders.length) return json({ error: '缺少订单数据' }, 400);
  const date = normalizeDate(body.date) || businessDate();
  const key = routeOrderKey(route, `today:${date}`), latestKey = routeOrderKey(route, 'latest');
  const lockKey = routeOrderKey(route, `lock:${date}`), lockToken = createLockToken();
  if (!(await acquireLock(env, lockKey, lockToken, ORDER_LOCK_TTL_SECONDS))) return json({ error: '当前线路正在保存订单，请稍后再试' }, 409);
  try {
    let existing = await redisGet(env, key);
    if (false) {
      const users = await listUsersByRoute(env, route);
      const candidates = await Promise.all(users.map(async user => {
        const value = await redisGet(env, legacyUserOrderKey(user.id, route, `today:${date}`));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      }));
      candidates.sort((a, b) => {
        const at = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
        const bt = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
        return bt - at;
      });
      existing = candidates.find(item => String(item.orderBatchId || '').trim()) || candidates[0] || null;
    }
    const orderBatchId = String(body.orderBatchId || '').trim() || existing?.orderBatchId || createBatchId(date, route);
    // 订单详情页的“更换车辆”只是修改当日车辆，不应重新按当前基准库计算订单。
    // 历史/今日订单必须继续使用原批次已经确认的门店顺序与匹配结果。
    const isVehicleOnlyUpdate = source === 'order-detail'
      && existing?.orderBatchId
      && orderBatchId === existing.orderBatchId
      && Array.isArray(existing.orders)
      && existing.orders.length > 0;
    if (!isVehicleOnlyUpdate) return json({ error: '原订单不存在或批次已变化，不能修改车辆' }, 409);

    const orders = existing.orders;
    const rawOrderCount = positiveInt(existing.rawOrderCount) || orders.length;
    const duplicateCount = Number(existing.duplicateCount) || 0;
    const incomingWeight = normalizeWeight(body.totalWeight ?? body.weight);
    const totalWeight = incomingWeight || normalizeWeight(existing?.totalWeight);
    const todayData = {
      orderBatchId, date, route, userId: String(existing.userId || userId).trim(),
      vehicle: String(body.vehicle || '').trim() || session.vehicle || String(existing?.vehicle || ''),
      orders, totalWeight, count: orders.length, uniqueStoreCount: orders.length,
      matchedCount: orders.filter(x => x.matched).length,
      newStoreCount: orders.filter(x => x.isNew).length,
      reviewCount: Number(existing.reviewCount) || 0,
      baseDatabaseAvailable: existing.baseDatabaseAvailable !== false,
      duplicateCount: Math.max(Number(existing.duplicateCount) || 0, duplicateCount),
      recognizedCount: positiveInt(existing.recognizedCount) || rawOrderCount, rawOrderCount,
      source: String(existing.source || source).trim(), updatedAt: new Date().toISOString()
    };
    const historyKey = routeOrderKey(route, `history:${date}`);
    let updatedHistory = null;
    let historyData = null;
    if (isVehicleOnlyUpdate) {
      historyData = await redisGet(env, historyKey);
      if (false) {
        const users = await listUsersByRoute(env, route);
        const legacyLists = await Promise.all(users.map(async user => {
          const legacy = await redisGet(env, legacyUserOrderKey(user.id, route, `history:${date}`));
          return Array.isArray(legacy) ? legacy : [];
        }));
        const merged = dedupeHistoryRecords(legacyLists.flat());
        historyData = merged.length ? merged : null;
      }
      const sourceHistory = Array.isArray(historyData) ? historyData : [existing];
      let found = false;
      updatedHistory = sourceHistory.map(item => {
        if (String(item?.orderBatchId || '').trim() !== orderBatchId) return item;
        found = true;
        return { ...item, vehicle: todayData.vehicle, updatedAt: todayData.updatedAt };
      });
      if (!found) {
        if (Array.isArray(historyData)) return json({ error: '原订单历史记录不存在，不能只修改车辆' }, 409);
        updatedHistory.push({
          ...existing,
          userId: todayData.userId,
          vehicle: todayData.vehicle,
          totalWeight: todayData.totalWeight,
          weight: todayData.totalWeight,
          updatedAt: todayData.updatedAt
        });
      }
      updatedHistory.sort((a, b) =>
        (Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0)
        - (Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0)
      );
      updatedHistory = updatedHistory.slice(0, 100);
    }

    // 更换车辆：今日订单、对应历史记录、latest 三者一起原子提交，
    // 避免网络/Redis故障造成“今日车辆已变、历史车辆未变”的半成功状态。
    await atomicSaveOrder(env, {
      lockKey,
      lockToken,
      todayKey: key,
      todayData,
      latestKey,
      latestData: { date, orderBatchId, updatedAt: todayData.updatedAt },
      historyKey,
      historyData: updatedHistory,
      expectedToday: existing,
      expectedHistory: Array.isArray(historyData) ? historyData : null
    });

    const saved = await readAfterWrite(env, key, orderBatchId, orders.length);
    if (!saved) throw new Error('订单已提交但服务器未确认保存成功，请重试');
    return json({ success: true, data: saved });
  } finally { await releaseLock(env, lockKey, lockToken).catch(() => {}); }
}

async function readOrder(request, env, session) {
  const url = new URL(request.url), requestedDate = normalizeDate(url.searchParams.get('date'));
  const route = normalizeRoute(url.searchParams.get('route')), userId = normalizeUserId(session.id);
  if (!route) return json({ error: '缺少调度线路' }, 400);
  if (!canUseRoute(session.user || session, route)) return json({ error: '无权使用该线路' }, 403);
  const batch = String(url.searchParams.get('orderBatchId') || url.searchParams.get('batch') || '').trim();

  // 未指定日期时只读取业务日，避免明日预上传通过 latest 提前进入首页“今日任务”。
  // 需要读取历史或明日数据的页面必须显式传 date。
  const date = requestedDate || businessDate();
  // 今日任务的主数据与历史汇总解耦：今日 key 可用时，历史迁移/汇总异常不能把首页或详情页整体变成 503。
  // 这尤其重要于旧用户数据迁移期间：history 缺失会触发 SCAN user:*，不应阻断已有的线路级 today 数据。
  let today = null;
  try {
    today = await redisGet(env, routeOrderKey(route, `today:${date}`));
  } catch (error) {
    console.warn('读取线路当日订单失败，继续尝试旧数据迁移', route, date, error?.message || error);
  }
  let historyData = null;
  try {
    historyData = await redisGet(env, routeOrderKey(route, `history:${date}`));
  } catch (error) {
    console.warn('读取线路历史数据失败，继续使用当日订单', route, date, error?.message || error);
  }
  if (false) {
    // 线路级数据是唯一权威来源；只有线路级 key 不存在时才读取 legacy。
    // legacy 可能分散在司机/送货员多个用户下，因此必须合并全部当前绑定用户。
    if (!today) {
      try {
        const users = await listUsersByRoute(env, route);
        const legacyToday = await Promise.all(users.map(async user => {
          const value = await redisGet(env, legacyUserOrderKey(user.id, route, `today:${date}`));
          return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
        }));
        const candidates = legacyToday.filter(Boolean);
        candidates.sort((a, b) => {
          const at = Date.parse(String(a.updatedAt || a.createdAt || '')) || 0;
          const bt = Date.parse(String(b.updatedAt || b.createdAt || '')) || 0;
          return bt - at;
        });
        today = candidates[0] || null;
        if (today) await redisSet(env, routeOrderKey(route, `today:${date}`), today);
      } catch (error) {
        console.warn('读取旧版当日订单失败', route, date, error?.message || error);
      }
    }
    if (!historyData) {
      try {
        const users = await listUsersByRoute(env, route);
        const legacyLists = await Promise.all(users.map(async user => {
          const value = await redisGet(env, legacyUserOrderKey(user.id, route, `history:${date}`));
          return Array.isArray(value) ? value : [];
        }));
        const merged = dedupeHistoryRecords(legacyLists.flat());
        historyData = merged.length ? merged : null;
        if (historyData) await redisSet(env, routeOrderKey(route, `history:${date}`), historyData);
      } catch (error) {
        console.warn('读取旧版历史订单失败，继续使用当日订单', route, date, error?.message || error);
      }
    }
  }
  // 汇总前先按 orderBatchId/稳定业务身份去重，避免旧迁移数据重复导致“x笔/总门店/总重量”被重复累计。
  const history = Array.isArray(historyData) ? dedupeHistoryRecords(historyData) : [];

  // 当日订单读取必须以“有有效门店”为有效数据。
  // 旧版本可能留下 today:<date> = 空对象/空 orders；这种脏数据不能阻断 history:<date> 的有效记录。
  const hasOrders = item => Boolean(item && Array.isArray(item.orders) && item.orders.length > 0);
  // history:<date> 本身就是服务器确认的业务日期，不能再因为旧记录内部 date
  // 缺失/格式不同/遗留旧日期而把有效运单过滤掉。
  // 历史查询入口正是按这个 key 读取，因此今日订单入口必须采用同一日期事实来源。
  const historyCandidates = history
    .filter(item => hasOrders(item))
    .sort((a, b) => (Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0) - (Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0));

  // 关键自愈：today 不存在、为空、或失效时，都允许从同日有效历史恢复。
  if (!hasOrders(today) && historyCandidates.length) {
    today = { ...historyCandidates[0], date, route: historyCandidates[0].route || route };
    try {
      await redisSet(env, routeOrderKey(route, 'today:' + date), today);
    } catch (error) {
      console.warn('当日订单从历史恢复到today失败，继续返回恢复数据', route, date, error?.message || error);
    }
  }

  // 指定批次时严格返回指定批次；未指定批次时比较 today 与 history 的更新时间，避免旧 today 覆盖当天更新。
  const updatedAtOf = item => Date.parse(String(item?.updatedAt || item?.createdAt || '')) || 0;
  let selected = hasOrders(today) ? today : null;
  if (batch) {
    selected = historyCandidates.find(item => String(item?.orderBatchId || '').trim() === batch)
      || (String(today?.orderBatchId || '').trim() === batch && hasOrders(today) ? today : null);
  } else {
    const latestHistory = historyCandidates[0] || null;
    if (!selected || (latestHistory && updatedAtOf(latestHistory) > updatedAtOf(selected))) selected = latestHistory;
    if (hasOrders(selected) && (!hasOrders(today) || updatedAtOf(selected) > updatedAtOf(today))) {
      today = selected;
      try { await redisSet(env, routeOrderKey(route, 'today:' + date), today); }
      catch (error) { console.warn('最新当日订单回写today失败', route, date, error?.message || error); }
    }
  }

  // 选中的记录一律补齐业务日/线路，避免旧历史记录因 date 缺失而被响应层过滤。
  if (hasOrders(selected)) {
    // 以 history:<date>/today:<date> 的业务日期为准，统一修正旧记录内部 date。
    selected = { ...selected, date, route: selected.route || route };
  }

  // today 有效但 history 缺少对应批次时，顺手恢复历史索引。
  if (hasOrders(selected) && !historyCandidates.some(item => String(item?.orderBatchId || '').trim() === String(selected.orderBatchId || '').trim())) {
    try {
      const repaired = [...history, { ...selected }];
      repaired.sort((a, b) => (Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0) - (Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0));
      await redisSet(env, routeOrderKey(route, 'history:' + date), repaired.slice(0, 100));
    } catch (error) {
      console.warn('当日订单恢复历史索引失败', route, date, error?.message || error);
    }
  }

  const dailyRecords = historyCandidates.length ? historyCandidates : (hasOrders(selected) ? [selected] : []);
  const summaryRecords = dailyRecords;
  const todayWaybillCount = summaryRecords.length;
  const summaryStores = summaryRecords.reduce((sum, item) => sum + (Number(item?.uniqueStoreCount) || Number(item?.count) || (Array.isArray(item?.orders) ? item.orders.length : 0)), 0);
  const summaryWeight = summaryRecords.reduce((sum, item) => sum + parseWeightToTons(item?.totalWeight ?? item?.weight), 0);
  const todaySummary = {
    storeCount: summaryStores,
    totalWeight: summaryWeight > 0 ? (Math.round((summaryWeight + Number.EPSILON) * 1000000) / 1000000) + 't' : ''
  };
  const responseToday = hasOrders(selected) ? selected : null;
  return json({ success: true, today: responseToday, history: dailyRecords, todayWaybillCount, todaySummary });
}

function positiveInt(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : 0; }
function normalizeUserId(value) { return String(value || '').trim().slice(0, 128); }
function isBoundRoute(session, route) { return normalizeRoute(session?.boundRouteId) === normalizeRoute(route); }
function createBatchId(date, route) { const stamp = new Date().toISOString().replace(/[-:.TZ]/g, ''); const suffix = (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/[^a-z0-9]/gi, '').slice(0, 12); return date + '-' + String(route || '').replace(/\D/g, '') + '-' + stamp + '-' + suffix; }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''), m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n < 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; return String(Math.round((tons + Number.EPSILON) * 1000000) / 1000000) + 't'; }
function businessDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'), m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function historyRecordSignature(item) {
  const batch = String(item?.orderBatchId || '').trim();
  if (batch) return 'batch:' + batch;
  const vehicle = String(item?.vehicle || '').trim().toLowerCase();
  const weight = String(item?.totalWeight ?? item?.weight ?? '').trim();
  const orders = Array.isArray(item?.orders) ? item.orders.map(order => {
    const storeId = String(order?.storeId || order?.baseCode || '').trim();
    const name = String(order?.name || order?.storeName || order?.shopName || '').trim().replace(/[\s\u3000（）()【】\[\]]/g, '').toLowerCase();
    const identity = storeId ? 'id:' + storeId : (name ? 'name:' + name : '');
    return identity ? { identity, weight: Number(order?.weight) || 0 } : null;
  }).filter(Boolean).sort((a, b) => String(a.identity + '|' + a.weight).localeCompare(String(b.identity + '|' + b.weight))) : [];
  return JSON.stringify({ vehicle, weight, orders });
}
function dedupeHistoryRecords(records) {
  const map = new Map();
  (Array.isArray(records) ? records : []).forEach(item => {
    const signature = historyRecordSignature(item);
    if (signature && !map.has(signature)) map.set(signature, item);
  });
  return [...map.values()];
}
function parseWeightToTons(value) {
  if (value === null || value === undefined || value === '') return 0;
  const text = String(value).trim().replace(/,/g, '');
  const match = text.match(/[\d]+(?:\.\d+)?/);
  if (!match) return 0;
  const n = Number(match[0]);
  if (!Number.isFinite(n)) return 0;
  if (/kg|千克|公斤/i.test(text)) return n / 1000;
  if (/吨|\bt\b/i.test(text)) return n;
  return n >= 1000 ? n / 1000 : n;
}

async function acquireLock(env, key, token, seconds) {
  const response = await redisFetch(env, `/set/${encodeURIComponent(key)}/${encodeURIComponent(token)}/NX/EX/${seconds}`, { method: 'POST' });
  if (!response.ok) return false;
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}
async function releaseLock(env, key, token) { const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end"; await redisFetch(env, '/eval', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify([script, 1, key, token]) }); }
async function redisGet(env, key) {
  const response = await redisFetch(env, `/get/${encodeURIComponent(key)}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Redis读取失败（HTTP ${response.status}）`);
  if (data.result === null || data.result === undefined || data.result === '') return null;
  try { return typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { return null; }
}
async function atomicSaveOrder(env, { lockKey, lockToken, todayKey, todayData, latestKey, latestData, historyKey, historyData, expectedToday, expectedHistory }) {
  if (!lockKey || !lockToken) throw new Error('订单保存锁信息缺失，拒绝写入');
  if (!historyKey || !Array.isArray(historyData)) throw new Error('订单历史数据不完整，拒绝保存');
  const expectedTodayJson = expectedToday === null || expectedToday === undefined ? '' : JSON.stringify(expectedToday);
  const expectedHistoryJson = expectedHistory === null || expectedHistory === undefined ? '' : JSON.stringify(expectedHistory);
  const script = [
    'local lock = redis.call("GET", KEYS[1])',
    'if lock ~= ARGV[1] then return "LOCK_LOST" end',
    'local currentToday = redis.call("GET", KEYS[2])',
    'if currentToday ~= ARGV[2] then return "CONFLICT_TODAY" end',
    'local currentHistory = redis.call("GET", KEYS[3])',
    'if currentHistory ~= ARGV[3] then return "CONFLICT_HISTORY" end',
    'redis.call("SET", KEYS[2], ARGV[4])',
    'redis.call("SET", KEYS[3], ARGV[5])',
    'redis.call("SET", KEYS[4], ARGV[6])',
    'return "OK"'
  ].join('\\n');
  const response = await redisFetch(env, '/eval', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([
      script, '4',
      lockKey, todayKey, historyKey, latestKey,
      lockToken, expectedTodayJson, expectedHistoryJson,
      JSON.stringify(todayData), JSON.stringify(historyData), JSON.stringify(latestData)
    ])
  });
  if (!response.ok) throw new Error(`订单原子保存失败（HTTP ${response.status}）`);
  const data = await response.json().catch(() => ({}));
  const result = String(data.result || '');
  if (result === 'LOCK_LOST') throw new Error('订单保存锁已失效，请刷新后重试');
  if (result === 'CONFLICT_TODAY' || result === 'CONFLICT_HISTORY') throw new Error('订单数据刚刚发生变化，请刷新后重试');
  if (result !== 'OK') throw new Error('订单原子保存未确认');
}

async function redisSet(env, key, value) {
  const response = await redisFetch(env, `/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Redis保存失败（HTTP ${response.status}）`);
  if (data.result !== undefined && data.result !== 'OK') throw new Error('Redis保存未确认');
}
async function readAfterWrite(env, key, batchId, count) { for (let attempt = 0; attempt < 3; attempt += 1) { const saved = await redisGet(env, key); if (saved?.orderBatchId === batchId && Array.isArray(saved.orders) && saved.orders.length === count) return saved; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 150 * (attempt + 1))); } return null; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
