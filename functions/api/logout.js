// functions/api/logout.js
import { clearSessionCookie } from './_auth.js';

export async function onRequest({ request }) {
  if (request.method !== 'POST') return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ success: true }), { status: 200, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Set-Cookie': clearSessionCookie()
  }});
}
