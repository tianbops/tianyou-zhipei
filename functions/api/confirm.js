export async function onRequest() {
  return new Response(JSON.stringify({
    success: false,
    code: 'LEGACY_API_DISABLED',
    error: '旧确认接口已停用，请使用V3流程'
  }), {
    status: 410,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-store'
    }
  });
}
