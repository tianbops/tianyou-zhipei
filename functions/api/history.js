// 天友智配One - 历史查询 API
// 历史数据按「线路 + 业务日期」独立存储，服务器为唯一真实数据源。
import { authRequired } from './_auth.js';

export async function onRequest({ request, env }) {
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);
  const session = await authRequired(request, env);
  if (!session?.route) return json({ error: '登录已失效或无权限' }, 401);

  const url = new URL(request.url);
  const date = normalizeDate(url.searchParams.get('date'));
  if (!date) return json({ error: 'Missing date parameter' }, 400);

  const key = `history:${session.route}:${date}`;
  try {
    if (request.method === 'DELETE') {
      const deleted = await redisCommand(env, ['DEL', key]);
      return json({ success: true, deleted: Number(deleted || 0) > 0, date });
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const result = await redisCommand(env, ['GET', key]);
    let records = [];
    if (result) {
      try { records = typeof result === 'string' ? JSON.parse(result) : result; } catch { records = []; }
    }
    return json(Array.isArray(records) ? records : []);
  } catch (error) {
    console.error('history api error', error);
    return json(request.method === 'DELETE' ? '历史记录删除失败' : '历史数据服务异常', 503);
  }
}

async function redisCommand(env, command) {
  const response = await fetch(env.UPSTASH_REDIS_REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`Redis HTTP ${response.status}`);
  const data = await response.json().catch(() => ({}));
  return data.result;
}

function normalizeDate(value) {
  const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-');
  const m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '';
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
