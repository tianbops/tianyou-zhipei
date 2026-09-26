export function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}})}
export async function body(request){try{return await request.json()}catch{return {}}}
