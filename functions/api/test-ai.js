export async function onRequest({ env }) {
  try {
    const response = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      prompt: 'Hello, respond with a JSON object {"status": "ok"}',
      image: '' // 不传图
    });
    return new Response(JSON.stringify({ success: true, response }));
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}
