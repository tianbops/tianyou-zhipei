// functions/api/login.js
// 登录入口：先确保测试/初始账号存在，再验证密码并建立服务器 Session。
import { createSession, sessionCookie } from './_auth.js';
import { hashPassword, verifyPassword, isPasswordHash } from './_password.js';
const REDIS_KEY='admin_users';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({success:false,error:'Method not allowed'},405);
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) return json({success:false,error:'Redis 未配置，登录服务暂不可用'},500);
  try {
    const body=await request.json().catch(()=>({}));
    const type=body.type==='admin'?'admin':'route';
    const account=String(body.account||'').trim();
    const password=String(body.password||'');
    if(!account||!password)return json({success:false,error:'账号和密码不能为空'},400);

    let users=await readUsers(env);
    // 关键修复：登录接口自己负责初始化默认测试账号。
    // 不能依赖管理员页面 /api/users，因为登录前用户本身没有 Session。
    const seeded=await ensureDefaultUsers(users,env);
    if(seeded.changed){users=seeded.users;await saveUsers(env,users)}

    let user;
    if(type==='admin') {
      user=users.find(u=>u&&u.role==='admin'&&String(u.name||'').trim()===account);
    } else {
      const route=normalizeRoute(account);
      user=users.find(u=>u&&u.role!=='admin'&&normalizeRoute(u.route)===route);
    }
    if(!user)return json({success:false,error:'用户名或线路不存在'},401);

    let valid=false;
    if(isPasswordHash(user.passwordHash)){
      try{valid=await verifyPassword(password,user.passwordHash)}catch(e){console.warn('password hash verification failed:',e?.message||e)}
    }
    // 兼容历史数据中的明文密码。
    if(!valid&&Object.prototype.hasOwnProperty.call(user,'password'))valid=String(user.password||'')===password;
    // 兼容初始化字段：旧数据可能只有 initialPassword。
    if(!valid&&user.initialPassword)valid=String(user.initialPassword)===password;
    // 环境变量作为最后的服务器端测试账号校验来源。
    if(!valid){
      const configured=type==='route'?String(env.DEFAULT_DRIVER_PASSWORD||env.DEFAULT_UNIFIED_PASSWORD||''):String(env.DEFAULT_ADMIN_PASSWORD||'');
      if(configured&&configured===password)valid=true;
    }
    if(!valid)return json({success:false,error:'用户名或密码错误'},401);

    const safeUser={id:user.id,name:user.name||'',route:normalizeRoute(user.route||''),role:user.role||'driver'};
    // 登录成功后迁移旧密码；迁移失败绝不阻断本次登录。
    if(!isPasswordHash(user.passwordHash)){
      try{
        const migratedHash=await hashPassword(password);
        users=users.map(item=>{
          if(String(item?.id)!==String(user.id))return item;
          const next={...item,passwordHash:migratedHash};
          delete next.password;
          delete next.initialPassword;
          return next;
        });
        await saveUsers(env,users);
        user=users.find(item=>String(item?.id)===String(user.id))||user;
      }catch(e){console.warn('password migration skipped:',e?.message||e)}
    }

    const token=await createSession(env,{...safeUser,sessionVersion:Number(user.sessionVersion||1)});
    return new Response(JSON.stringify({success:true,user:safeUser}),{status:200,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store','Set-Cookie':sessionCookie(token)}});
  }catch(error){
    console.error('login error',error);
    return json({success:false,error:'登录服务异常：'+(error?.message||'unknown')},500);
  }
}

async function readUsers(env){
  const resp=await fetch(`${env.UPSTASH_REDIS_REST_URL}/get/${REDIS_KEY}`,{headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`},cache:'no-store'});
  if(!resp.ok)throw new Error('用户数据读取失败');
  const data=await resp.json();
  if(!data.result)return[];
  try{const users=JSON.parse(data.result);return Array.isArray(users)?users:[]}catch{return[]}
}
async function saveUsers(env,users){
  const resp=await fetch(`${env.UPSTASH_REDIS_REST_URL}/set/${REDIS_KEY}`,{method:'POST',headers:{Authorization:`Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(JSON.stringify(users)),cache:'no-store'});
  if(!resp.ok)throw new Error('用户数据保存失败');
  const data=await resp.json().catch(()=>({}));
  if(data.result!==undefined&&data.result!=='OK')throw new Error('用户数据保存未确认');
}

function defaultUsers(env){
  const adminPassword=String(env.DEFAULT_ADMIN_PASSWORD||'');
  const driverPassword=String(env.DEFAULT_DRIVER_PASSWORD||env.DEFAULT_UNIFIED_PASSWORD||'');
  return[
    {id:1,name:String(env.DEFAULT_ADMIN_NAME||'tianbo').trim(),route:'',role:'admin',initialPassword:adminPassword,createdAt:'2026-08-25T00:00:00.000Z'},
    {id:17,name:'17号线',route:'17号线',role:'driver',initialPassword:driverPassword,createdAt:'2026-08-25T00:00:00.000Z'}
  ].filter(u=>u.initialPassword);
}
async function ensureDefaultUsers(users,env){
  const list=Array.isArray(users)?[...users]:[];let changed=false;
  for(const required of defaultUsers(env)){
    let i=list.findIndex(u=>String(u?.id)===String(required.id));
    if(i<0&&required.route)i=list.findIndex(u=>normalizeRoute(u?.route)===normalizeRoute(required.route));
    if(i<0){
      const{initialPassword,...meta}=required;
      list.push({...meta,passwordHash:await hashPassword(initialPassword),sessionVersion:1});changed=true;continue;
    }
    const current=list[i]||{};
    if(required.id===1&&current.role!=='admin'){list[i]={...current,role:'admin',sessionVersion:Number(current.sessionVersion||1)+1};changed=true}
    if(!isPasswordHash(current.passwordHash)&&current.password){
      list[i]={...current,passwordHash:await hashPassword(String(current.password)),sessionVersion:Number(current.sessionVersion||1)+1};delete list[i].password;changed=true;
    }
    if(!current.passwordHash&&required.initialPassword){
      list[i]={...list[i],passwordHash:await hashPassword(required.initialPassword),sessionVersion:Number(list[i].sessionVersion||1)+1};delete list[i].initialPassword;changed=true;
    }
  }
  return{users:list,changed};
}
function normalizeRoute(input){const value=String(input||'').trim(),match=value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);return match?`${String(parseInt(match[1]||match[2],10)).padStart(2,'0')}号线`:value}
function json(payload,status=200){return new Response(JSON.stringify(payload),{status,headers:{'Content-Type':'application/json;charset=utf-8','Cache-Control':'no-store'}})}
