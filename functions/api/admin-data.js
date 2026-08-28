// 管理中心数据 API
// 管理中心不使用浏览器 localStorage 保存业务数据；数据统一保存到 Upstash。
import { authRequired } from './_auth.js';

const KEY = 'admin_dashboard_data';
const DEFAULTS = {
  vehicles: [{ id: 1, plate: '渝DK7692', route: '17号线', status: 'active' }],
  ocr: [],
  backups: [],
  logs: []
};

export async function onRequest({ request, env }) {
  const session = await authRequired(request, env, { admin: true });
  if (!session) return json({ error: '仅管理员可访问' }, 403);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ error: 'Redis not configured' }, 500);

  try {
    if (request.method === 'GET') {
      const data = await redisGet(env, KEY);
      return json({ success: true, data: mergeDefaults(data) });
    }
    if (request.method === 'PUT') {
      const body = await request.json().catch(() => ({}));
      const current = mergeDefaults(await redisGet(env, KEY));
      const data = {
        vehicles: Array.isArray(body.vehicles) ? body.vehicles : current.vehicles,
        ocr: Array.isArray(body.ocr) ? body.ocr : current.ocr,
        backups: Array.isArray(body.backups) ? body.backups : current.backups,
        logs: Array.isArray(body.logs) ? body.logs.slice(-200) : current.logs
      };
      await redisSet(env, KEY, data);
      return json({ success: true, data });
    }
    return json({ error: 'Method not allowed' }, 405);
  } catch (e) {
    console.error('admin-data error', e);
    return json({ error: '管理数据服务异常' }, 503);
  }
}

function mergeDefaults(data) {
  return {
    vehicles: Array.isArray(data?.vehicles) ? data.vehicles : structuredClone(DEFAULTS.vehicles),
    ocr: Array.isArray(data?.ocr) ? data.ocr : [],
    backups: Array.isArray(data?.backups) ? data.backups : [],
    logs: Array.isArray(data?.logs) ? data.logs : []
  };
}

async function redisGet(env, key) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store'
  });
  if (!r.ok) throw Error('Redis读取失败');
  const d = await r.json().catch(() => ({}));
  if (!d.result) return null;
  try { return JSON.parse(d.result); } catch { return null; }
}

async function redisSet(env, key, value) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value)), cache: 'no-store'
  });
  if (!r.ok) throw Error('Redis保存失败');
  const d = await r.json().catch(() => ({}));
  if (d.result !== undefined && d.result !== 'OK') throw Error('Redis保存未确认');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
