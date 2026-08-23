// functions/api/init.js
export async function onRequest({ env }) {
  const UPSTASH_URL = env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = env.UPSTASH_REDIS_REST_TOKEN;
  const ADMIN_PASSWORD = env.ADMIN_PASSWORD || 'admin123'; // 从环境变量读取

  // ... 其他代码

  // 创建默认管理员用户时使用 ADMIN_PASSWORD
  const defaultUsers = [
    { id: 1, name: '管理员', route: 'all', password: ADMIN_PASSWORD, role: 'admin' },
    // ...
  ];
  // 保存到 Upstash
}