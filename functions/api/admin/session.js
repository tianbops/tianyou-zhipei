// 天友智配One - 主系统管理员专用会话校验
import { requireSystemAdmin } from '../_auth.js';

export async function onRequest({ request, env }) {
  if (request.method !== 'GET') return json({ success: false, error: 'Method not allowed' }, 405);
  const admin = await requireSystemAdmin(request, env);
  if (!admin) return json({ success: false, error: '无系统管理权限' }, 403);
  return json({
    success: true,
    apiVersion: 'admin-v1',
    user: {
      id: String(admin.id || ''),
      username: String(admin.username || ''),
      name: String(admin.name || admin.username || ''),
      role: 'system_admin',
      adminLevel: 'primary'
    }
  });
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
