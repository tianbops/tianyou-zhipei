// 天友智配One - 内部用户注册
// 普通账号必须使用管理员签发的邀请码；管理员账号不走此注册流程。
import { createSession, sessionCookie } from './_auth.js';
import { publicUser, redisCommand } from './_data.js';

const INVITE_PREFIX='system:invite:';
const INVITE_INDEX='system:invites';

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return json({ success:false,error:'Method not allowed' },405);
  if (!redisReady(env)) return json({ success:false,error:'注册服务未配置，请检查 Upstash 配置' },500);
  if (!env.SESSION_SECRET) return json({ success:false,error:'SESSION_SECRET 未配置，注册服务暂不可用' },500);
  try {
    const body=await request.json().catch(()=>({}));
    const username=normalizeUsername(body.username);
    const password=String(body.password||'');
    const inviteCode=normalizeInvite(body.inviteCode);
    if(!/^[a-z0-9_]{3,32}$/.test(username)) return json({success:false,error:'用户名需为3-32位字母、数字或下划线'},400);
    if(password.length<6||password.length>72) return json({success:false,error:'密码需为6-72位'},400);
    if(!inviteCode) return json({success:false,error:'请输入邀请码'},400);

    const usernameKey=`user:username:${encodeURIComponent(username)}`;
    const existing=await redisCommand(env,['GET',usernameKey]);
    if(existing) return json({success:false,error:'用户名已存在，请换一个用户名'},409);

    const id=crypto.randomUUID();
    const passwordHash=await hashPassword(password);
    const now=new Date().toISOString();
    const user={
      id,username,name:username,phone:'',
      boundRouteId:'',route:'',routeDuty:'',vehicle:'',
      role:'driver',passwordHash,status:'active',
      sessionVersion:1,schemaVersion:2,createdAt:now,updatedAt:now
    };
    const inviteHash=await sha256(inviteCode);
    const userKey=`user:${id}`;
    const script=`
local inviteKey=KEYS[1]
local indexKey=KEYS[2]
local usernameKey=KEYS[3]
local userKey=KEYS[4]
local raw=redis.call('GET',inviteKey)
if not raw then return 'INVALID' end
local ok,invite=pcall(cjson.decode,raw)
if not ok or not invite then return 'INVALID' end
if tostring(invite.status or 'active') ~= 'active' then return 'DISABLED' end
local now=tonumber(ARGV[2])
local expires=tonumber(invite.expiresAt or 0)
if expires>0 and now>=expires then return 'EXPIRED' end
local maxUses=tonumber(invite.maxUses or 0)
local used=tonumber(invite.usedCount or 0)
if maxUses>0 and used>=maxUses then return 'EXHAUSTED' end
if redis.call('EXISTS',usernameKey)==1 then return 'USERNAME_EXISTS' end
invite.usedCount=used+1
invite.lastUsedAt=ARGV[2]
if maxUses>0 and invite.usedCount>=maxUses then invite.status='active' end
redis.call('SET',usernameKey,ARGV[3])
redis.call('SET',userKey,ARGV[1])
redis.call('SET',inviteKey,cjson.encode(invite))
redis.call('SADD',indexKey,ARGV[4])
return 'OK'
`;
    const result=await redisCommand(env,['EVAL',script,'4',INVITE_PREFIX+inviteHash,INVITE_INDEX,usernameKey,userKey,JSON.stringify(user),String(Date.now()),id,inviteHash]);
    if(result==='INVALID') return json({success:false,error:'邀请码无效，请联系管理员获取有效邀请码'},400);
    if(result==='DISABLED') return json({success:false,error:'邀请码已停用'},400);
    if(result==='EXPIRED') return json({success:false,error:'邀请码已过期，请联系管理员重新获取'},400);
    if(result==='EXHAUSTED') return json({success:false,error:'邀请码已用完，请联系管理员重新获取'},400);
    if(result==='USERNAME_EXISTS') return json({success:false,error:'用户名已存在，请换一个用户名'},409);
    if(result!=='OK') throw new Error('邀请码注册提交失败');

    const safeUser=publicUser(user);
    const token=await createSession(env,safeUser);
    return new Response(JSON.stringify({success:true,user:safeUser,needSetup:true}),{
      status:201,
      headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Set-Cookie':sessionCookie(token)}
    });
  }catch(error){
    console.error('register error',error);
    return json({success:false,error:'注册服务异常，请稍后重试',detail:safeError(error)},500);
  }
}

async function hashPassword(password){
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const iterations=100000;
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},material,256);
  return `pbkdf2-sha256$${iterations}$${base64(salt)}:${base64(new Uint8Array(bits))}`;
}
function base64(bytes){let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary)}
async function sha256(value){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
function normalizeUsername(value){return String(value||'').trim().toLowerCase()}
function normalizeInvite(value){return String(value||'').trim().toUpperCase().replace(/\\s+/g,'')}
function safeError(error){const message=String(error?.message||error||'').trim();return message?message.slice(0,180):'unknown'}
function redisReady(env){return Boolean(String(env.UPSTASH_REDIS_REST_URL||'').trim()&&String(env.UPSTASH_REDIS_REST_TOKEN||'').trim())}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}})}
