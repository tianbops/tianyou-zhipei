export async function onRequest() {
  const upstream = 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/dist/assets/worker-entry-C9UNuyOJ.js';
  const response = await fetch(upstream, {
    cf: { cacheEverything: true, cacheTtl: 86400 }
  });
  if (!response.ok) {
    return new Response('PaddleOCR Worker 加载失败', {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
  const headers = new Headers(response.headers);
  headers.set('Content-Type', 'text/javascript; charset=utf-8');
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('Access-Control-Allow-Origin', '*');
  return new Response(response.body, { status: 200, headers });
}
