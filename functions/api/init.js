// 系统初始化：仅负责在用户数据库完全不存在时创建初始数据。
// 已初始化的数据绝不因为再次访问 /api/init 而被覆盖，尤其不能覆盖管理员密码。
export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({ success: false, error: 'Upstash credentials missing' }, 500);

  const key = 'admin_users';
  try {
    const existing = await redisGet(env, key);
    if (Array.isArray(existing) && existing.length) {
      return json({ success: true, initialized: true, updated: false, usersCount: existing.length, message: '系统已经初始化，不修改现有用户数据' });
    }

    // 初始账号只在数据库为空时创建；正式部署建议通过 Cloudflare 环境变量提供账号。
    const adminName = String(env.ADMIN_NAME || 'tianbo').trim();
    const adminPassword = String(env.ADMIN_PASSWORD || '').trim();
    if (!adminPassword) return json({ success: false, error: '首次初始化必须设置 ADMIN_PASSWORD 环境变量' }, 500);

    const users = [
      { id: 1, name: adminName, route: 'all', password: adminPassword, role: 'admin' },
      { id: 17, name: '17号线', route: '17号线', password: 'tianyou2024', role: 'driver' }
    ];
    await redisSet(env, key, users);
    return json({ success: true, initialized: false, updated: true, usersCount: users.length });
  } catch (error) {
    console.error('init error', error);
    return json({ success: false, error: '初始化服务异常' }, 500);
  }
}

async function redisGet(env, key) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` }, cache: 'no-store' });
  if (!r.ok) throw new Error('读取初始化数据失败');
  const d = await r.json();
  if (!d.result) return null;
  try { return JSON.parse(d.result); } catch { return null; }
}
async function redisSet(env, key, value) {
  const r = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}`, { method: 'POST', headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(JSON.stringify(value)) });
  if (!r.ok) throw new Error('写入初始化数据失败');
}
function json(payload, status = 200) { return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } }); }
