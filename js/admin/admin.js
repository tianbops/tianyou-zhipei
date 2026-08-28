// js/admin/admin.js
// 管理中心主入口
// 重要：浏览器不再保存任何管理业务数据；DB 只是内存缓存，真实数据来自服务器。
const ADMIN_DATA_KEYS=['vehicles','ocr','backups','logs'];
const adminMemory=Object.create(null);let adminSaveTimer=null;
const DB={
 get(key,defaultVal){return Object.prototype.hasOwnProperty.call(adminMemory,key)?adminMemory[key]:defaultVal},
 set(key,val){adminMemory[key]=val;updateStats();if(key==='users')syncUsersToUpstash(val);else if(ADMIN_DATA_KEYS.includes(key))scheduleAdminSave()},
 addLog(action,detail){const logs=this.get('logs',[]).slice();logs.unshift({id:Date.now(),time:new Date().toLocaleString(),action,detail,user:Auth.getCurrentRoute()});if(logs.length>200)logs.length=200;this.set('logs',logs)}
};
function authHeaders(){return Auth.getAuthHeaders?Auth.getAuthHeaders():{}}
async function syncUsersToUpstash(users){try{const response=await fetch('/api/users',{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({users})});if(!response.ok)throw new Error(`HTTP ${response.status}`);console.log('用户数据已保存到服务器')}catch(e){console.error('服务器用户数据保存失败',e);showToast('服务器保存失败，请联网后重试','error')}}
async function loadAdminData(){const response=await fetch('/api/admin-data',{cache:'no-store',credentials:'same-origin',headers:{...authHeaders()}});const data=await response.json().catch(()=>({}));if(!response.ok||!data.success)throw new Error(data.error||`HTTP ${response.status}`);for(const key of ADMIN_DATA_KEYS)adminMemory[key]=Array.isArray(data.data?.[key])?data.data[key]:[]}
let adminSaveInFlight=false;
async function saveAdminData(){if(adminSaveInFlight)return;adminSaveInFlight=true;try{const payload={};for(const key of ADMIN_DATA_KEYS)payload[key]=DB.get(key,[]);const response=await fetch('/api/admin-data',{method:'PUT',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify(payload)});const data=await response.json().catch(()=>({}));if(!response.ok||!data.success)throw new Error(data.error||`HTTP ${response.status}`)}catch(e){console.error('管理数据保存失败',e);showToast('服务器保存失败，请联网后重试','error')}finally{adminSaveInFlight=false}}
function scheduleAdminSave(){clearTimeout(adminSaveTimer);adminSaveTimer=setTimeout(saveAdminData,250)}
async function updateUnifiedPassword(password){const value=String(password||'').trim();if(value.length<6)throw new Error('统一密码至少需要6位');const response=await fetch('/api/users-unified-password',{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({password:value})});const data=await response.json().catch(()=>({}));if(!response.ok||!data.success)throw new Error(data.error||'统一密码更新失败');showToast(data.message||`已更新 ${data.updated||0} 个普通用户密码`,'success');return data}
function getUnifiedPassword(){return ''}
function formatRouteCode(input){if(!input)return'';const num=parseInt(String(input).trim(),10);if(isNaN(num)||num<1)return'';return String(num).padStart(2,'0')+'号线'}
async function isRouteRegistered(route){const user=await Auth.findUserByRoute(route);return user!==null}
function openDialog(id){document.getElementById(id)?.classList.add('active')}function closeDialog(id){document.getElementById(id)?.classList.remove('active')}
function showToast(msg,type='success'){const toast=document.getElementById('toast');if(!toast)return;toast.textContent=msg;toast.className='toast show '+type;setTimeout(()=>toast.classList.remove('show'),3000)}
function updateStats(){const users=DB.get('users',[]),vehicles=DB.get('vehicles',[]),logs=DB.get('logs',[]),stores=DB.get('stores',[]),ocr=DB.get('ocr',[]);document.getElementById('statUsers').textContent=users.length;document.getElementById('statVehicles').textContent=vehicles.filter(v=>v.status==='active').length;document.getElementById('statStores').textContent=stores.length;document.getElementById('statLogs').textContent=logs.length;document.getElementById('userBadge').textContent=users.length;document.getElementById('vehicleBadge').textContent=vehicles.filter(v=>v.status==='active').length;document.getElementById('ocrBadge').textContent=ocr.filter(o=>o.status==='pending').length;document.getElementById('logBadge').textContent=logs.length}
async function initAdmin(){if(!(await Auth.checkAuth()))return;try{const users=await Auth.fetchUsersFromUpstash();if(!Array.isArray(users))throw new Error('服务器未返回用户数据');adminMemory.users=users;await loadAdminData()}catch(e){console.error(e);showToast('服务器数据加载失败，请联网后重试','error');return}updateStats()}
async function logout(){if(confirm('确定退出登录吗？'))await Auth.logout()}
function openRouteSelectDialog(){const input=document.getElementById('routeSelectInput');if(input)input.value='';openDialog('routeSelectDialog')}
async function confirmRouteSelect(){const input=document.getElementById('routeSelectInput'),rawInput=input?.value.trim()||'';if(!rawInput){showToast('请输入线路编号','error');return}const route=formatRouteCode(rawInput);if(!route){showToast('请输入有效数字 (如 1, 17, 105)','error');return}try{if(!await isRouteRegistered(route)){showToast('该线路未开通','error');return}closeDialog('routeSelectDialog');window.location.href=`pages/route_edit.html?route=${encodeURIComponent(route)}&from=admin`}catch{showToast('线路信息读取失败，请联网后重试','error')}}
document.addEventListener('keydown',e=>{if(e.key!=='Enter')return;const dialog=document.getElementById('routeSelectDialog');if(dialog?.classList.contains('active'))confirmRouteSelect()});
document.addEventListener('DOMContentLoaded',initAdmin);
window.openDialog=openDialog;window.closeDialog=closeDialog;window.showToast=showToast;window.updateStats=updateStats;window.logout=logout;window.openRouteSelectDialog=openRouteSelectDialog;window.confirmRouteSelect=confirmRouteSelect;window.formatRouteCode=formatRouteCode;window.isRouteRegistered=isRouteRegistered;window.getUnifiedPassword=getUnifiedPassword;window.updateUnifiedPassword=updateUnifiedPassword;window.DB=DB;
