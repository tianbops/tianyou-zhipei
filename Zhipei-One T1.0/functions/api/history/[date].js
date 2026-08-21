export async function onRequest(context) {
  const { request, params } = context;
  const date = params.date;
  
  const UPSTASH_URL = context.env.UPSTASH_REDIS_REST_URL;
  const UPSTASH_TOKEN = context.env.UPSTASH_REDIS_REST_TOKEN;
  
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    return new Response(JSON.stringify({ error: 'Redis not configured' }), { 
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  
  try {
    const redisKey = `history:${date}`;
    const redisResponse = await fetch(`${UPSTASH_URL}/get/${redisKey}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    
    if (redisResponse.ok) {
      const data = await redisResponse.json();
      if (data.result) {
        return new Response(JSON.stringify(JSON.parse(data.result)), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }
    
    return new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' }
    });
    
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}