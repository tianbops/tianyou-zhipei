// 天友智配One - 当前登录用户
import { authRequired } from './_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  const session = await authRequired(request, env);
  if (!session) return json({ success: false, error: '登录已失效' }, 401);
  return json({ success: true, user: {
    id: session.id,
    name: session.name || '',
    route: session.route,
    vehicle: session.vehicle || ''
  } });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
