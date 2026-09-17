// Zhipei One - 微信小程序登录入口
// 当前阶段只负责建立小程序认证协议；正式上线前由服务端校验微信 code 并绑定现有 userId。
import { createMiniToken } from './_auth.js';

export async function onRequestPost({ request, env }) {
  try {
    const body = await request.json();
    const code = String(body?.code || '').trim();
    const username = String(body?.username || '').trim();
    const password = String(body?.password || '');

    if (!code) return json({ message: '缺少微信登录凭证' }, 400);
    if (!username || !password) return json({ message: '首次绑定需要输入智配 One 账号和密码' }, 400);

    // 绑定逻辑将在微信开放平台 AppID/Secret 配置完成后执行。
    // 此处禁止直接把微信身份当作新用户，必须绑定现有 userId。
    return json({ message: '微信登录服务尚未完成配置，请先使用账号密码登录' }, 501);
  } catch (error) {
    return json({ message: error?.message || '微信登录失败' }, 400);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}
