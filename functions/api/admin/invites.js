// 天友智配One - 管理员邀请码
import { requireSystemAdmin } from '../_auth.js';
import { redisCommand, redisGet, recordAdminLog } from '../_data.js';

const INDEX_KEY='system:invites';
const PREFIX='system:invite:';

export async function onRequest({request,env}){
  const admin=await requireSystemAdmin(request,env);
  if(!admin) return json({success:false,error:'无系统管理权限'},403);
  if(!env.UPSTASH_REDIS_REST_URL||!env.UPSTASH_REDIS_REST_TOKEN) return json({success:false,error:'Redis not configured'},500);
  try{
    if(request.method==='GET') return listInvites(env);
    if(request.method==='POST') return createInvite(request,env,admin);
    if(request.method==='PATCH') return updateInvite(request,env,admin);
    return json({success:false,error:'Method not allowed'},405);
  }catch(error){
    console.error('admin invites error',error);
    return json({success:false,error:error?.message||'邀请码服务异常'},503);
  }
}

async function listInvites(env){
  const hashes=await redisCommand(env,['SMEMBERS',INDEX_KEY]);
  const list=Array.isArray(hashes)?hashes:[];
  const items=[];
  for(const hash of list){
    const invite=await redisGet(env,PREFIX+String(hash));
    if(invite&&typeof invite==='object') items.push(publicInvite(invite));
  }
  items.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  return json({success:true,invites:items});
}

async function createInvite(request,env,admin){
  const body=await request.json().catch(()=>({}));
  const maxUses=normalizeUses(body.maxUses);
  const expiresIn=normalizeExpiry(body.expiresIn);
  const code=makeCode();
  const hash=await sha256(code);
  const now=Date.now();
  const expiresAt=expiresIn===0?0:now+expiresIn*86400000;
  const invite={
    schemaVersion:1,
    hash,
    maxUses,
    usedCount:0,
    expiresAt,
    status:'active',
    createdAt:new Date(now).toISOString(),
    createdBy:String(admin.id||''),
    lastUsedAt:''
  };
  const script=`
local key=KEYS[1]
local indexKey=KEYS[2]
if redis.call('EXISTS',key)==1 then return 'EXISTS' end
redis.call('SET',key,ARGV[1])
redis.call('SADD',indexKey,ARGV[2])
return 'OK'
`;
  const result=await redisCommand(env,['EVAL',script,'2',PREFIX+hash,INDEX_KEY,JSON.stringify(invite),hash]);
  if(result!=='OK') throw new Error('邀请码生成失败，请重试');
  await recordAdminLog(env,admin,'create_invite','invite',hash,{maxUses,expiresAt}).catch(()=>{});
  return json({success:true,invite:{...publicInvite(invite),code}},201);
}

async function updateInvite(request,env,admin){
  const body=await request.json().catch(()=>({}));
  const hash=String(body.hash||'').trim().toLowerCase();
  if(!/^[a-f0-9]{64}$/.test(hash)) return json({success:false,error:'邀请码标识无效'},400);
  const invite=await redisGet(env,PREFIX+hash);
  if(!invite||typeof invite!=='object') return json({success:false,error:'邀请码不存在'},404);
  if(body.status!==undefined){
    const status=String(body.status||'').trim();
    if(status!=='active'&&status!=='disabled') return json({success:false,error:'状态无效'},400);
    if(status==='active'&&Number(invite.expiresAt||0)>0&&Date.now()>=Number(invite.expiresAt)) return json({success:false,error:'邀请码已过期，不能重新启用'},409);
    invite.status=status;
  }
  invite.updatedAt=new Date().toISOString();
  await redisCommand(env,['SET',PREFIX+hash,JSON.stringify(invite)]);
  await recordAdminLog(env,admin,'update_invite','invite',hash,{status:invite.status}).catch(()=>{});
  return json({success:true,invite:publicInvite(invite)});
}

function publicInvite(invite){
  const maxUses=Number(invite.maxUses||0);
  const usedCount=Number(invite.usedCount||0);
  let status=String(invite.status||'active');
  if(status==='active'&&Number(invite.expiresAt||0)>0&&Date.now()>=Number(invite.expiresAt)) status='expired';
  if(status==='active'&&maxUses>0&&usedCount>=maxUses) status='exhausted';
  return {
    hash:String(invite.hash||''),
    maskedCode:'••••-••••',
    maxUses,
    usedCount,
    expiresAt:Number(invite.expiresAt||0),
    status,
    createdAt:String(invite.createdAt||''),
    lastUsedAt:String(invite.lastUsedAt||'')
  };
}
function normalizeUses(value){
  const n=String(value||'1').trim().toLowerCase();
  if(n==='unlimited'||n==='0'||n==='不限') return 0;
  const v=Number(n);
  return [1,5,10].includes(v)?v:1;
}
function normalizeExpiry(value){
  const n=String(value||'30').trim().toLowerCase();
  if(n==='permanent'||n==='0'||n==='永久') return 0;
  const v=Number(n);
  return [7,30,90].includes(v)?v:30;
}
function makeCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes=crypto.getRandomValues(new Uint8Array(8));
  let out='';
  for(const b of bytes) out+=chars[b%chars.length];
  return out.slice(0,4)+'-'+out.slice(4);
}
async function sha256(value){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(bytes)).map(x=>x.toString(16).padStart(2,'0')).join('');
}
function json(payload,status=200){
  return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}
