// 天友智配One V1.0 - 当前登录用户
import { authRequired } from './_auth.js';
import { publicUser } from './_data.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return json({ success: false, error: 'Method not allowed' }, 405);
  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效' }, 401);
  return json({ success: true, apiVersion: 'v1', user: publicUser(session.user || session) });
}
function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
