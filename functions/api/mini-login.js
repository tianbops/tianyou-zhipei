// Zhipei One - 微信小程序统一登录
// 微信身份只绑定现有 userId，不创建第二套账号。
import { createMiniToken } from './_auth.js';
import { publicUser, redisGet } from './_data.js';

export async function onRequestPost({ request, env }) {
  if (request.method !== 'POST') return json({ message: 'Method not allowed' }, 405);
  if (!redisReady(env)) return json({ message: '登录服务未配置，请检查 Upstash 配置' }, 500);
  if (!env.SESSION_SECRET) return json({ message: 'SESSION_SECRET 未配置' }, 500);

  try {
    const body = await request.json().catch(() => ({}));
    const code = String(body.code || '').trim();
    const username = normalizeUsername(body.username || body.account);
    const password = String(body.password || '');

    if (!code) return json({ message: '缺少微信登录凭证' }, 400);

    const wechat = await exchangeCode(env, code);
    if (!wechat.openid) return json({ message: '微信身份验证失败' }, 401);

    const openidKey = `wx:openid:${wechat.openid}`;
    let userId = await redisGet(env, openidKey);

    if (!userId) {
      if (!username || !password) {
        return json({
          success: false,
          code: 'BIND_REQUIRED',
          message: '首次使用微信登录，请先输入智配 One 账号和密码完成绑定'
        }, 401);
      }

      userId = await authenticateUser(env, username, password);
      if (!userId) return json({ message: '智配 One 账号或密码错误' }, 401);

      const bound = await redisSetNx(env, openidKey, userId);
      if (!bound) {
        userId = await redisGet(env, openidKey);
        if (!userId) return json({ message: '微信账号绑定失败，请重试' }, 409);
      }

      if (wechat.unionid) await redisSetNx(env, `wx:unionid:${wechat.unionid}`, userId);
    }

    const user = parseRecord(await redisGet(env, `user:${userId}`));
    if (!user || user.status === 'disabled') return json({ message: '用户不存在或已停用' }, 401);

    const safeUser = publicUser(user);
    const token = await createMiniToken(env, user);
    return json({
      success: true,
      token,
      user: safeUser,
      bound: true
    });
  } catch (error) {
    console.error('mini-login error', error);
    return json({ message: '微信登录服务异常，请稍后重试' }, 500);
  }
}

async function exchangeCode(env, code) {
  const appId = String(env.WECHAT_APPID || env.WX_APPID || '').trim();
  const appSecret = String(env.WECHAT_APPSECRET || env.WX_APPSECRET || '').trim();
  if (!appId || !appSecret) throw new Error('微信 AppID/Secret 未配置');

  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', appId);
  url.searchParams.set('secret', appSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');

  const response = await fetch(url.toString(), { cache: 'no-store' });
  if (!response.ok) throw new Error('微信身份接口请求失败');
  const data = await response.json().catch(() => ({}));
  if (data.errcode) throw new Error(`微信身份验证失败：${data.errcode}`);
  return {
    openid: String(data.openid || '').trim(),
    unionid: String(data.unionid || '').trim()
  };
}

async function authenticateUser(env, username, password) {
  const userId = await redisGet(env, `user:username:${encodeURIComponent(username)}`);
  if (!userId) return '';
  const user = parseRecord(await redisGet(env, `user:${userId}`));
  if (!user || user.status === 'disabled' || !user.passwordHash) return '';
  return await verifyPassword(password, user.passwordHash) ? String(user.id || userId) : '';
}

async function verifyPassword(password, encoded) {
  try {
    const value = String(encoded || '');
    let iterations = 100000;
    let salt;
    let stored;
    const parts = value.split('$');
    if (parts.length === 3 && parts[0] === 'pbkdf2-sha256') {
      iterations = Number(parts[1]);
      [salt, stored] = parts[2].split(':');
    } else {
      [salt, stored] = value.split(':');
    }
    if (!salt || !stored || !Number.isInteger(iterations) || iterations < 1 || iterations > 100000) return false;
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: decodeBase64(salt), iterations, hash: 'SHA-256' }, material, 256);
    return timingSafeEqual(new Uint8Array(bits), decodeBase64(stored));
  } catch {
    return false;
  }
}

function decodeBase64(value) {
  const raw = atob(String(value || ''));
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function redisSetNx(env, key, value) {
  const response = await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(value)}/NX`, {
    headers: { Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}` },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error('Redis 写入失败');
  const data = await response.json().catch(() => ({}));
  return data.result === 'OK';
}

function parseRecord(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    const first = JSON.parse(value);
    if (typeof first === 'string') return JSON.parse(first);
    return first;
  } catch {
    return null;
  }
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase();
}

function redisReady(env) {
  return Boolean(env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}
