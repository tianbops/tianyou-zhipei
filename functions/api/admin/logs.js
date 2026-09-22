// 天友智配One V1.0 - 系统管理日志
import { requireSystemAdmin } from '../_auth.js';
import { redisGet } from '../_data.js';

export async function onRequest({ request, env }) {
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);
  if (request.method !== 'GET') return json({ success: false, error: 'Method not allowed' }, 405);
  try {
    const logs = await redisGet(env, 'system:admin:logs');
    return json({ success: true, logs: Array.isArray(logs) ? logs.slice(0, 200) : [] });
  } catch (error) {
    return json({ success: false, error: error?.message || '日志读取失败' }, 503);
  }
}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});}
