// functions/api/test-ai.js
// 天友智配One：AI 绑定健康检查
// 不再向视觉模型发送空 image，避免 Cloudflare Workers AI 5006 参数校验错误。

export async function onRequest({ env }) {
  const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

  if (!env.AI || typeof env.AI.run !== 'function') {
    return json({
      success: false,
      error: 'Cloudflare Workers AI 未绑定，请在 Pages 项目中配置 AI Binding，变量名必须为 AI'
    }, 500);
  }

  try {
    const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
      prompt: '只返回 JSON：{"status":"ok"}',
      max_tokens: 32,
      temperature: 0
    });

    return json({
      success: true,
      model: '@cf/meta/llama-3.1-8b-instruct-fast',
      response
    });
  } catch (e) {
    return json({
      success: false,
      error: e?.message || 'Workers AI 调用失败'
    }, 500);
  }
}
