// 天友智配One - 历史查询 API
// 历史数据按「17号线 + 业务日期」独立存储，服务器为唯一真实数据源。
import { authRequired } from './_auth.js';

const ROUTE = '17号线';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  const session = await authRequired(request, env, { route: ROUTE });
  if (!session) return json({ error: '登录已失效或无权限' }, 401);

  const url = new URL(request.url);
  const date = normalizeDate(url.searchParams.get('date'));
  if (!date) return json({ error: 'Missing date parameter' }, 400);

  try {
    const key = `history:${ROUTE}:${date}`;
    const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
      cache: 'no-store'
    });
    if (!response.ok) return json({ error: '历史数据读取失败' }, 502);

    const data = await response.json().catch(() => ({}));
    let records = [];
    if (data.result) {
      try { records = typeof data.result === 'string' ? JSON.parse(data.result) : data.result; } catch { records = []; }
    }
    return json(Array.isArray(records) ? records : []);
  } catch (error) {
    console.error('history api error', error);
    return json({ error: '历史数据服务异常' }, 503);
  }
}

function normalizeDate(value) {
  const s = String(value || '').trim().replace(/[年月]/g, '-').replace(/日/g, '').replace(/[/.]/g, '-');
  const m = s.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : '';
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
