// Zhipei One - 线路历史查询 API
// 今日订单/历史记录按线路+日期统一存储；userId 保留在记录内用于审计与兼容。允许提前一天上传并查询明日运单。
import { authRequired } from './_auth.js';
import { canManageRoute, canUseRoute, getRoute, legacyUserOrderKey, normalizeRoute, routeOrderKey, redisCommand, redisGet, redisSet, listUsersByRoute } from './_data.js';

const HISTORY_DAYS = 100;
const FUTURE_DAYS = 1;

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env, { allowAnyRoute: true });
  if (!session?.id) return json({ error: '登录已失效或权限信息不完整' }, 401);
  const url = new URL(request.url);
  const date = normalizeDate(url.searchParams.get('date'));
  const route = normalizeRoute(url.searchParams.get('route') || session.boundRouteId), userId = normalizeUserId(session.id);
  if (!canUseRoute(session.user || session, route)) return json({ error: '无权使用该线路' }, 403);
  const routeRecord = await getRoute(env, route);
  if (!routeRecord || routeRecord.status === 'disabled') return json({ error: '当前线路不存在或已停用' }, 404);

  try {
    if (request.method === 'DELETE') {
      // 历史记录属于线路业务数据。可调度线路的用户可以查看，但只有该线路绑定用户可删除。
      if (!canManageRoute(session.user || session, route)) {
        return json({ success: false, error: '只有绑定该线路的用户可以删除历史记录' }, 403);
      }
      if (!date) return json({ success: false, error: 'Missing date parameter' }, 400);
      return await deleteHistoryRecord(env, route, date, String(url.searchParams.get('orderBatchId') || url.searchParams.get('batch') || '').trim());
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

    // 历史数据清理不能阻塞当前历史读取。SCAN 在历史量较大或 Redis 响应较慢时，
    // 如果等待清理完成，会导致修正详情页一直停留在“正在读取修正记录”。
    // 清理作为后台维护任务执行，当前请求立即继续读取目标日期。
    maybePurgeExpiredHistory(env, route).catch(error => console.warn('历史清理失败，稍后重试', error?.message || error));

    // 不传日期时返回该用户/线路全部历史日期。
    if (!date) return await listAllHistory(env, userId, route, session, routeRecord);

    const key = routeOrderKey(route, `history:${date}`);
    let records = await readHistoryOrRecover(env, userId, route, date, key, session);
    const { records: cleaned, changed } = dedupeHistory(records);
    if (changed || cleaned.length !== records.length) {
      // 历史查询的自清理不能绕过订单日期锁，否则会与确认入库的原子写入发生“预期历史版本冲突”。
      const lockKey = routeOrderKey(route, `lock:${date}`);
      const lockToken = createLockToken();
      if (await acquireMigrationLock(env, lockKey, lockToken, 30)) {
        try {
          const latest = await redisGet(env, key);
          const latestCleaned = dedupeHistory(Array.isArray(latest) ? latest : []).records;
          if (JSON.stringify(latestCleaned) !== JSON.stringify(latest ?? [])) {
            await redisSet(env, key, latestCleaned);
          }
          records = latestCleaned;
        } finally {
          await releaseMigrationLock(env, lockKey, lockToken).catch(() => {});
        }
      } else {
        // 确认入库正在持有日期锁时，不抢写历史，只返回当前读取结果。
        records = Array.isArray(records) ? records : [];
      }
    }
    return json(records);
  } catch (error) {
    console.error('history api error', error);
    return json({ error: request.method === 'DELETE' ? '历史记录删除失败' : '历史数据服务异常' }, 503);
  }
}

async function readHistoryOrRecover(env, userId, route, date, key, session) {
  let result = await redisGet(env, key);
  if (Array.isArray(result) && result.length) return result;

  // 路线历史已统一为共享数据。旧版本仍可能把同一条线路的历史分散在多个绑定用户键下，
  // 因此迁移必须合并全部绑定用户，而不是只读取当前登录用户，避免第二个用户覆盖第一个用户的数据。
  if (isBoundRoute(session, route)) {
    const migrated = await migrateLegacyHistory(env, route, date, key);
    if (migrated.length) return migrated;
  }

  // 兼容旧版本半成功数据：历史没有记录，但同日期 today 数据仍存在。
  const todayKey = routeOrderKey(route, `today:${date}`);
  let today = await redisGet(env, todayKey);
  let todayFromLegacy = false;
  if (!today && isBoundRoute(session, route)) {
    const users = await listUsersByRoute(env, route);
    const legacyToday = await Promise.all(users.map(async user => {
      const value = await redisGet(env, legacyUserOrderKey(user.id, route, `today:${date}`));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    }));
    today = legacyToday
      .filter(Boolean)
      .sort((a, b) => String(b?.updatedAt || '').localeCompare(String(a?.updatedAt || '')))[0] || null;
    todayFromLegacy = Boolean(today);
  }
  if (today && Array.isArray(today.orders) && today.orders.length && normalizeDate(today.date) === date) {
    const recovered = recoverFromToday(today, userId, route, date);
    if (historySignature(recovered)) {
      const lockKey = routeOrderKey(route, `lock:${date}`);
      const lockToken = createLockToken();
      if (await acquireMigrationLock(env, lockKey, lockToken, 30)) {
        try {
          const latest = await redisGet(env, key);
          if (!Array.isArray(latest) || !latest.length) await redisSet(env, key, [recovered]);
          if (todayFromLegacy) await redisSet(env, todayKey, today);
        } finally {
          await releaseMigrationLock(env, lockKey, lockToken).catch(() => {});
        }
      }
      return [recovered];
    }
  }
  return [];
}

async function migrateLegacyHistory(env, route, date, key) {
  // 历史迁移与确认/删除必须共用同一“线路+日期”业务锁，禁止迁移写入绕过订单原子提交。
  const lockKey = routeOrderKey(route, `lock:${date}`);
  const token = createLockToken();
  if (!(await acquireMigrationLock(env, lockKey, token, 10))) {
    const current = await redisGet(env, key);
    return Array.isArray(current) ? current : [];
  }

  try {
    const current = await redisGet(env, key);
    if (Array.isArray(current) && current.length) return current;

    const users = await listUsersByRoute(env, route);
    const legacyLists = await Promise.all(users.map(async user => {
      const legacyKey = legacyUserOrderKey(user.id, route, `history:${date}`);
      const value = await redisGet(env, legacyKey);
      return Array.isArray(value) ? value : [];
    }));
    const merged = dedupeHistory(legacyLists.flat()).records;
    if (!merged.length) return [];

    const expected = JSON.stringify(current ?? null);
    const next = JSON.stringify(merged);
    const result = await redisCommand(env, [
      'EVAL',
      `local current = redis.call('GET', KEYS[1])
if (current ~= ARGV[1]) then return 'CONFLICT' end
redis.call('SET', KEYS[1], ARGV[2])
return 'OK'`,
      '1',
      key,
      expected,
      next
    ]);
    if (result === 'OK') return merged;
    const after = await redisGet(env, key);
    return Array.isArray(after) ? after : merged;
  } finally {
    await releaseMigrationLock(env, lockKey, token).catch(() => {});
  }
}


function recoverFromToday(today, userId, route, date) {
  return {
    orderBatchId: String(today.orderBatchId || '').trim(),
    date,
    route,
    userId,
    vehicle: String(today.vehicle || '').trim(),
    count: Number(today.count) || today.orders.length,
    uniqueStoreCount: Number(today.uniqueStoreCount) || today.orders.length,
    weight: today.totalWeight ?? today.weight ?? '',
    totalWeight: today.totalWeight ?? today.weight ?? '',
    orders: today.orders,
    correctionDetails: Array.isArray(today.correctionDetails)
      ? today.correctionDetails
      : buildCorrectionDetailsFromOrders(today.orders),
    matchedCount: Number(today.matchedCount) || 0,
    newStoreCount: Number(today.newStoreCount) || 0,
    reviewCount: Number(today.reviewCount) || 0,
    duplicateCount: Number(today.duplicateCount) || 0,
    recognizedCount: Number(today.recognizedCount) || today.orders.length,
    rawOrderCount: Number(today.rawOrderCount) || today.orders.length,
    baseDatabaseAvailable: today.baseDatabaseAvailable !== false,
    source: String(today.source || 'recovered-from-today'),
    updatedAt: today.updatedAt || new Date().toISOString()
  };
}

async function listAllHistory(env, userId, route, session, routeRecord = null) {
  // 正常线路数据只读取最近100天+未来1天的固定窗口。一次 pipeline 获取全部日期，
  // 避免 history:* / today:* 的 SCAN 随历史 Key 数量增长而变慢。
  const dates = historyDateWindow();
  const routeHistoryKeys = dates.map(date => routeOrderKey(route, 'history:' + date));
  const routeTodayKeys = dates.map(date => routeOrderKey(route, 'today:' + date));
  const routeValues = await redisPipelineGet(env, [...routeHistoryKeys, ...routeTodayKeys]);
  const routeValueMap = new Map();
  routeHistoryKeys.forEach((key, index) => {
    const value = routeValues[index];
    if (value !== null && value !== undefined) routeValueMap.set(key, value);
  });
  routeTodayKeys.forEach((key, index) => {
    const value = routeValues[routeHistoryKeys.length + index];
    if (value !== null && value !== undefined) routeValueMap.set(key, value);
  });
  const existingRouteHistoryKeys = routeHistoryKeys.filter(key => routeValueMap.has(key));
  const existingRouteTodayKeys = routeTodayKeys.filter(key => routeValueMap.has(key));

  // 线路级数据与旧版 user 级数据可能处于“部分迁移”状态。
  // 绑定用户查询历史时必须同时发现两侧数据：
  // - 线路级 key 已存在：该日期以线路级数据为准（包括 []，防止已删除记录被 legacy 重新复活）。
  // - 线路级 key 不存在：才使用全部绑定用户的 legacy 数据，并按批次去重。
  let legacyHistoryKeys = [];
  let legacyTodayKeys = [];
  if (isBoundRoute(session, route)) {
    try {
      // 正常线路记录已经保存 boundUserIds；优先直接使用，避免每次历史查询再 SCAN 全部 user:*。
      // 仅在旧线路记录缺少 boundUserIds 时回退到兼容扫描。
      let userIds = Array.isArray(routeRecord?.boundUserIds)
        ? routeRecord.boundUserIds.map(id => String(id || '').trim()).filter(Boolean)
        : [];
      if (!userIds.length) {
        const users = await listUsersByRoute(env, route);
        userIds = users.map(user => String(user?.id || '').trim()).filter(Boolean);
      }
      const legacyResults = await Promise.all(userIds.map(async userIdValue => {
        const legacyPrefix = 'user:' + encodeKey(userIdValue) + ':route:' + encodeKey(route) + ':orders:';
        const [h, t] = await Promise.all([
          scanKeys(env, legacyPrefix + 'history:*'),
          scanKeys(env, legacyPrefix + 'today:*')
        ]);
        return { history: h, today: t };
      }));
      legacyHistoryKeys = legacyResults.flatMap(item => item.history).filter(key => {
        const date = normalizeDate(String(key).split(':history:').pop());
        return date && isHistoryDateInWindow(date);
      });
      legacyTodayKeys = legacyResults.flatMap(item => item.today).filter(key => {
        const date = normalizeDate(String(key).split(':today:').pop());
        return date && isHistoryDateInWindow(date);
      });
    } catch (error) {
      console.warn('旧版历史索引读取失败，继续使用线路级历史', error?.message || error);
    }
  }

  const routeTodaySet = new Set(existingRouteTodayKeys);

  // 先读取所有需要参与展示的 key；同一 key 只保留一次。
  const keyMap = new Map();
  existingRouteHistoryKeys.forEach(key => keyMap.set(key, { type: 'history', source: 'route' }));
  existingRouteTodayKeys.forEach(key => keyMap.set(key, { type: 'today', source: 'route' }));

  // legacy key 不能直接覆盖线路级 key；后面按“日期”判断线路级 key 是否存在。
  legacyHistoryKeys.forEach(key => {
    const date = normalizeDate(String(key).split(':history:').pop());
    if (!date || existingRouteHistoryKeys.some(routeKey => String(routeKey).endsWith(':history:' + date))) return;
    keyMap.set(key, { type: 'history', source: 'legacy' });
  });
  legacyTodayKeys.forEach(key => {
    const date = normalizeDate(String(key).split(':today:').pop());
    if (!date || existingRouteTodayKeys.some(routeKey => String(routeKey).endsWith(':today:' + date))) return;
    keyMap.set(key, { type: 'today', source: 'legacy' });
  });

  const keys = [...keyMap.keys()];
  if (!keys.length) return json([]);

  const missingKeys = keys.filter(key => !routeValueMap.has(key));
  const missingValues = missingKeys.length ? await redisPipelineGet(env, missingKeys) : [];
  const missingValueMap = new Map(missingKeys.map((key, index) => [key, missingValues[index]]));
  const values = keys.map(key => routeValueMap.has(key) ? routeValueMap.get(key) : missingValueMap.get(key));
  const grouped = new Map();

  // 路线级 history 优先；同日期的 legacy history 不参与，避免部分删除后旧数据复活。
  keys.forEach((key, index) => {
    const meta = keyMap.get(key);
    const raw = values[index];
    const type = meta.type;
    const source = meta.source;

    if (type === 'history') {
      const date = normalizeDate(String(key).split(':history:').pop());
      if (!date) return;
      const records = Array.isArray(raw) ? raw : [];

      // 线路级 key 存在即拥有该日期的权威性，即使 records=[] 也不能用 legacy 补回。
      if (source === 'route') {
        grouped.set(date, records);
        return;
      }

      // legacy 只用于线路级 key 尚不存在的日期。
      if (routeHistoryKeys.some(routeKey => String(routeKey).endsWith(':history:' + date))) return;
      const existing = grouped.get(date) || [];
      grouped.set(date, existing.concat(records));
      return;
    }

    const date = normalizeDate(String(key).split(':today:').pop());
    if (!date || !raw || !Array.isArray(raw.orders) || !raw.orders.length) return;

    // history 优先于 today；route today 也优先于 legacy today。
    if (grouped.has(date)) return;
    if (routeHistoryKeys.some(routeKey => String(routeKey).endsWith(':history:' + date))) return;
    if (source === 'legacy' && routeTodaySet.has(routeOrderKey(route, 'today:' + date))) return;

    const recovered = recoverFromToday(raw, userId, route, date);
    if (!historySignature(recovered)) return;
    grouped.set(date, [recovered]);
  });

  const entries = [];
  for (const [date, rawRecords] of grouped.entries()) {
    const cleaned = dedupeHistory(rawRecords).records;
    if (!cleaned.length) continue;
    entries.push({ date, records: cleaned });
  }
  entries.sort((a, b) => b.date.localeCompare(a.date));
  return json(entries);
}

async function deleteHistoryRecord(env, route, date, batchId) {
  const key = routeOrderKey(route, `history:${date}`);
  const lockKey = routeOrderKey(route, `lock:${date}`);
  const lockToken = createLockToken();
  if (!(await acquireMigrationLock(env, lockKey, lockToken, 30))) {
    return json({ success: false, error: '该日期数据正在处理中，请稍后重试' }, 409);
  }

  try {
    let records = await redisGet(env, key);
    // 路线级历史不存在时，删除操作也必须按“全部绑定用户 legacy 数据合并”规则恢复，
    // 不能只迁移当前用户，否则同线路另一用户的旧历史可能被遗漏。
    if (!Array.isArray(records)) {
      records = await migrateLegacyHistory(env, route, date, key);
    }
    if (!Array.isArray(records) || !records.length) return json({ success: true, deleted: 0, date });

    const current = dedupeHistory(records).records;
    const target = batchId ? current.find(item => String(item?.orderBatchId || '').trim() === batchId) : null;
    if (!target) return json({ success: false, error: '未找到要删除的历史记录' }, 404);

    const targetBatchId = String(target?.orderBatchId || '').trim();
    const remaining = targetBatchId
      ? current.filter(item => String(item?.orderBatchId || '').trim() !== targetBatchId)
      : current.filter(item => historySignature(item) !== historySignature(target));
    const deleted = current.length - remaining.length;

    const todayKey = routeOrderKey(route, `today:${date}`);
    const latestKey = routeOrderKey(route, 'latest');
    const [today, latest] = await Promise.all([
      redisGet(env, todayKey),
      redisGet(env, latestKey)
    ]);
    const deleteToday = Boolean(today && targetBatchId && String(today?.orderBatchId || '').trim() === targetBatchId);
    const clearLatest = Boolean(latest && targetBatchId && String(latest?.orderBatchId || '').trim() === targetBatchId && normalizeDate(latest?.date) === date);

    // 同一天允许存在多笔独立运单。删除“当前今日批次”时，如果还有其他批次，
    // 必须把最新剩余批次提升为今日订单，不能因为删除最新一笔而让首页暂时显示“今日无单”。
    const promotedToday = deleteToday && remaining.length
      ? remaining[0]
      : null;
    const promotedLatest = clearLatest && promotedToday
      ? { date, orderBatchId: String(promotedToday.orderBatchId || '').trim(), updatedAt: promotedToday.updatedAt || new Date().toISOString() }
      : null;

    await atomicDeleteHistory(env, {
      historyKey: key,
      expectedHistory: current,
      remaining,
      todayKey,
      deleteToday,
      expectedToday: today,
      replacementToday: promotedToday,
      latestKey,
      clearLatest,
      expectedLatest: latest,
      replacementLatest: promotedLatest,
      lockKey,
      lockToken
    });
    return json({
      success: true,
      deleted,
      date,
      orderBatchId: batchId,
      removedSameData: 0,
      todayDeleted: deleteToday,
      latestCleared: clearLatest,
      todayPromoted: Boolean(promotedToday)
    });
  } finally {
    await releaseMigrationLock(env, lockKey, lockToken).catch(() => {});
  }
}


async function atomicDeleteHistory(env, { historyKey, expectedHistory, remaining, todayKey, deleteToday, expectedToday, replacementToday, latestKey, clearLatest, expectedLatest, replacementLatest, lockKey, lockToken }) {
  const script = `
local lock = redis.call('GET', KEYS[4])
if lock ~= ARGV[11] then return 'LOCK_LOST' end
local currentHistory = redis.call('GET', KEYS[1])
if currentHistory ~= ARGV[1] then return 'CONFLICT' end
if ARGV[3] == '1' then
  local currentToday = redis.call('GET', KEYS[2])
  if currentToday ~= ARGV[4] then return 'CONFLICT_TODAY' end
end
if ARGV[5] == '1' then
  local currentLatest = redis.call('GET', KEYS[3])
  if currentLatest ~= ARGV[6] then return 'CONFLICT_LATEST' end
end
redis.call('SET', KEYS[1], ARGV[2])
if ARGV[3] == '1' then
  if ARGV[7] == '1' then
    redis.call('SET', KEYS[2], ARGV[8])
  else
    redis.call('DEL', KEYS[2])
  end
end
if ARGV[5] == '1' then
  if ARGV[9] == '1' then
    redis.call('SET', KEYS[3], ARGV[10])
  else
    redis.call('DEL', KEYS[3])
  end
end
return 'OK'
`;
  const expectedHistoryJson = JSON.stringify(expectedHistory);
  const remainingJson = JSON.stringify(remaining);
  const expectedTodayJson = expectedToday === null || expectedToday === undefined ? '' : JSON.stringify(expectedToday);
  const expectedLatestJson = expectedLatest === null || expectedLatest === undefined ? '' : JSON.stringify(expectedLatest);
  const replacementTodayJson = replacementToday ? JSON.stringify(replacementToday) : '';
  const replacementLatestJson = replacementLatest ? JSON.stringify(replacementLatest) : '';
  const result = await redisCommand(env, [
    'EVAL',
    script,
    '4',
    historyKey,
    todayKey,
    latestKey,
    lockKey,
    expectedHistoryJson,
    remainingJson,
    deleteToday ? '1' : '0',
    expectedTodayJson,
    clearLatest ? '1' : '0',
    expectedLatestJson,
    replacementToday ? '1' : '0',
    replacementTodayJson,
    replacementLatest ? '1' : '0',
    replacementLatestJson,
    lockToken
  ]);
  if (result === 'LOCK_LOST') throw new Error('历史记录保存锁已失效，请刷新后重试');
  if (result === 'CONFLICT' || result === 'CONFLICT_TODAY' || result === 'CONFLICT_LATEST') {
    throw new Error('历史记录刚刚发生变化，请刷新后重试');
  }
  if (result !== 'OK') throw new Error('历史记录原子删除未确认');
}

async function acquireMigrationLock(env, key, token, seconds) {
  const result = await redisCommand(env, ['SET', key, token, 'NX', 'EX', String(seconds)]);
  return result === 'OK';
}

async function releaseMigrationLock(env, key, token) {
  const script = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
  await redisCommand(env, ['EVAL', script, '1', key, token]);
}

function createLockToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function historyDateWindow() {
  const today = businessDate();
  const dates = [];
  for (let offset = -(HISTORY_DAYS - 1); offset <= FUTURE_DAYS; offset += 1) dates.push(addDays(today, offset));
  return dates.filter(Boolean);
}
function isHistoryDateInWindow(date) {
  const normalized = normalizeDate(date);
  if (!normalized) return false;
  const today = businessDate();
  const cutoff = addDays(today, -(HISTORY_DAYS - 1));
  const futureCutoff = addDays(today, FUTURE_DAYS);
  return normalized >= cutoff && normalized <= futureCutoff;
}

async function maybePurgeExpiredHistory(env, route) {
  // 不再每次 GET 都扫描整条线路历史。用短期维护锁把清理频率限制为每线路约 5 分钟一次，
  // 避免用户打开历史页时与正常读取同时触发全量 SCAN。
  const lockKey = routeOrderKey(route, 'maintenance:history-purge');
  const token = createLockToken();
  const acquired = await acquireMigrationLock(env, lockKey, token, 300);
  if (!acquired) return;
  try {
    await purgeExpiredHistory(env, route);
  } finally {
    await releaseMigrationLock(env, lockKey, token).catch(() => {});
  }
}
async function purgeExpiredHistory(env, route) {
  const today = businessDate();
  const cutoff = addDays(today, -(HISTORY_DAYS - 1));
  const futureCutoff = addDays(today, FUTURE_DAYS);
  const keys = await scanKeys(env, routeOrderKey(route, 'history:*'));
  if (!keys.length) return;
  const commands = [];
  for (const key of keys) {
    const date = normalizeDate(String(key).split(':history:').pop());
    if (!date || date < cutoff || date > futureCutoff) commands.push(['DEL', key]);
  }
  if (commands.length) await redisPipeline(env, commands);
}

async function scanKeys(env, pattern) {
  let cursor = '0', keys = [];
  const MAX_PAGES = 1000;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/scan/${cursor}/match/${encodeURIComponent(pattern)}/count/100`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`Redis SCAN 失败（HTTP ${response.status}）`);
    const data = await response.json().catch(() => null);
    const result = data?.result;
    if (!Array.isArray(result) || result.length < 2) throw new Error('Redis SCAN 返回格式异常');
    keys.push(...(Array.isArray(result[1]) ? result[1] : []));
    cursor = String(result[0] || '0');
    if (cursor === '0') return keys;
  }
  throw new Error('Redis SCAN 超过安全分页上限，拒绝返回不完整索引');
}

function dedupeHistory(input) { const map = new Map(); let changed = false; for (const item of input) { if (!item || typeof item !== 'object') { changed = true; continue; } const batchId = String(item?.orderBatchId || '').trim(); const route = String(item?.route || '').trim(); const date = normalizeDate(item?.date); const signature = batchId && date ? `batch:${route}:${date}:${batchId}` : historySignature(item); if (!signature) { changed = true; continue; } const old = map.get(signature); if (!old) map.set(signature, item); else { changed = true; if (compareUpdatedAt(item, old) > 0) map.set(signature, item); } } const records = Array.from(map.values()).sort((a, b) => compareUpdatedAt(b, a)); if (records.length !== input.length) changed = true; return { records, changed }; }
function buildCorrectionDetailsFromOrders(orders) {
  return (Array.isArray(orders) ? orders : []).map(item => {
    const from = String(item?.rawName || (Array.isArray(item?.rawNames) ? item.rawNames[0] : '') || '').trim();
    const to = String(item?.baseName || item?.name || '').trim();
    if (!from || !to || from === to) return null;
    const normalize = value => String(value || '')
      .normalize('NFKC')
      .replace(/[\s\u3000，,。；;：:（）()【】\[\]<>《》“”\"'‘’·\-_/]/g, '')
      .toLowerCase();
    if (normalize(from) === normalize(to)) return null;
    return { storeId: String(item?.storeId || '').trim(), code: String(item?.code || '').trim(), from, to };
  }).filter(Boolean);
}

function historySignature(record) { const route = String(record?.route || '').trim(), date = normalizeDate(record?.date), vehicle = String(record?.vehicle || '').trim().toLowerCase(), weight = normalizeWeight(record?.totalWeight ?? record?.weight), orders = Array.isArray(record?.orders) ? record.orders : []; if (!date && !orders.length && !weight) return ''; const stores = orders.map(item => { const storeId = String(item?.storeId || item?.baseCode || '').trim(); const name = normalizeStoreName(item?.name || item?.storeName || item?.shopName || item?.['门店名称']); return storeId ? 'id:' + storeId : name ? 'name:' + name : ''; }).filter(Boolean).sort(); return JSON.stringify({ route, date, vehicle, weight, stores }); }
function normalizeStoreName(value) { return String(value || '').trim().replace(/[\s\u3000（）()【】\[\]]/g, '').replace(/谊品鲜/g, '谊品生鲜').replace(/\b20\d{2}\b/g, '').replace(/临时/g, '').toLowerCase(); }
function normalizeWeight(value) { if (value === null || value === undefined || value === '') return ''; const s = String(value).trim().replace(/,/g, ''), m = s.match(/[\d]+(?:\.\d+)?/); if (!m) return ''; const n = Number(m[0]); if (!Number.isFinite(n) || n < 0) return ''; const tons = /吨|\bt\b/i.test(s) ? n : /kg|千克|公斤/i.test(s) ? n / 1000 : n >= 1000 ? n / 1000 : n; return `${(Math.round((tons + Number.EPSILON) * 1000000) / 1000000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`; }
function compareUpdatedAt(a, b) { return (Date.parse(String(a?.updatedAt || a?.createdAt || '')) || 0) - (Date.parse(String(b?.updatedAt || b?.createdAt || '')) || 0); }
function isBoundRoute(session, route) { return normalizeRoute(session?.boundRouteId) === normalizeRoute(route); }
function normalizeUserId(value) { return String(value || '').trim().slice(0, 128); }
function encodeKey(value) { return encodeURIComponent(String(value || '').trim()).replace(/%/g, '_'); }

async function redisPipeline(env, commands) {
  if (!Array.isArray(commands) || !commands.length) return [];
  return Promise.all(commands.map(command => redisCommand(env, command)));
}

async function redisPipelineGet(env, keys) {
  return redisPipeline(env, keys.map(key => ['GET', key])).then(results => results.map(item => {
    const value = item?.result !== undefined ? item.result : item;
    if (value === null || value === undefined || value === '') return null;
    try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; }
  }));
}

function normalizeDate(value) { const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-'), m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : ''; }
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
