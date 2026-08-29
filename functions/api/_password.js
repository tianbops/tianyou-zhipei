// functions/api/_password.js
// Cloudflare Workers 原生 Web Crypto 密码哈希：PBKDF2-HMAC-SHA-256。
// 数据库只保存 passwordHash，不保存明文密码。
const ITERATIONS = 310000;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
function bytesToB64(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s)}
function b64ToBytes(s){const raw=atob(s);return Uint8Array.from(raw,c=>c.charCodeAt(0))}
function equal(a,b){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a[i]^b[i];return x===0}
export async function hashPassword(password){
  const salt=crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),{name:'PBKDF2'},false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:ITERATIONS,hash:'SHA-256'},key,KEY_BYTES*8);
  return `pbkdf2-sha256$${ITERATIONS}$${bytesToB64(salt)}$${bytesToB64(new Uint8Array(bits))}`;
}
export async function verifyPassword(password,stored){
  if(typeof stored!=='string'||!stored.startsWith('pbkdf2-sha256$'))return false;
  const parts=stored.split('$'); if(parts.length!==4)return false;
  const iterations=Number(parts[1]); if(!Number.isSafeInteger(iterations)||iterations<100000||iterations>2000000)return false;
  try{const salt=b64ToBytes(parts[2]),expected=b64ToBytes(parts[3]);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),{name:'PBKDF2'},false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations,hash:'SHA-256'},key,expected.length*8);return equal(new Uint8Array(bits),expected)}catch{return false}
}
export function isPasswordHash(value){return typeof value==='string'&&value.startsWith('pbkdf2-sha256$')}
