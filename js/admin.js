const $=s=>document.querySelector(s);
let users=[];
let routes=[];

document.addEventListener('DOMContentLoaded', async ()=>{
  document.querySelectorAll('.tab').forEach(btn=>btn.onclick=()=>switchTab(btn.dataset.tab));
  $('#refreshUsers').onclick=loadUsers;
  $('#refreshRoutes').onclick=loadRoutes;
  $('#refreshLogs').onclick=loadLogs;
  $('#resetDataBtn').onclick=resetData;
  $('#saveRoute').onclick=saveRoute;
  $('#backBtn').onclick=()=>history.back();
  await boot();
});

async function boot(){
  try{
    const me=await api('/api/me');
    if(!me.success||me.user?.role!=='system_admin') throw new Error('当前账号没有系统管理权限');
    $('#adminUser').textContent=(me.user.name||me.user.username)+' · 系统管理员';
    const results = await Promise.allSettled([loadUsers(), loadRoutes(), loadLogs()]);
    const failed = results.filter(x => x.status === 'rejected');
    if (failed.length) notice(`管理接口异常：${failed.map(x => x.reason?.message || '未知错误').join('；')}`, true);
  }catch(e){notice(e.message||'管理员身份验证失败',true)}
}
async function loadUsers(){
  try{const r=await api('/api/admin/users'); if(!r.success) throw new Error(r.error||'用户读取失败'); users=r.users||[]; renderUsers(); fillSelects()}catch(e){notice(e.message,true)}
}
async function loadRoutes(){
  try{const r=await api('/api/routes'); if(!r.success) throw new Error(r.error||'路线读取失败'); routes=r.routes||[]; renderRoutes()}catch(e){notice(e.message,true)}
}
async function loadLogs(){
  const endpoint='/api/admin/logs';
  try{const r=await api(endpoint);if(!r.success)throw new Error(`${endpoint}：${r.error||'日志读取失败'}`);$('#logList').innerHTML=(r.logs||[]).map(x=>`<article class="route-card"><div class="name">${esc(x.action)}</div><div class="meta">${esc(x.createdAt)} · ${esc(x.targetType)} · ${esc(x.targetId)}</div></article>`).join('')||'<div class="meta">暂无日志</div>'; return true}
  catch(e){notice(e.message,true); throw e}}
function renderUsers(){
  $('#userCount').textContent=users.length;
  $('#userList').innerHTML=users.map(u=>`<article class="user-card">
    <div class="user-main"><div><div class="name">${esc(u.name||u.username)}</div><div class="meta">${esc(u.username)} · ${esc(u.id)}</div></div><span class="badge">${esc(u.status==='active'?'正常':'停用')}</span></div>
    <div class="meta">角色：${esc(u.role)} · 绑定：${esc(u.boundRouteId||'未绑定')} ${u.routeDuty?'· '+esc(u.routeDuty):''}</div>
    <div class="actions">
      <button onclick="toggleUser('${escAttr(u.id)}','${u.status==='active'?'disabled':'active'}')">${u.status==='active'?'停用':'启用'}</button>
      <button onclick="resetPassword('${escAttr(u.id)}')">重置密码</button>
      <button onclick="setRole('${escAttr(u.id)}','${u.role==='system_admin'?'driver':'system_admin'}')">${u.role==='system_admin'?'取消管理员':'设为管理员'}</button>
    </div>
  </article>`).join('')||'<div class="meta">暂无用户</div>';
}
function renderRoutes(){
  $('#routeList').innerHTML=routes.map(r=>`<article class="route-card"><div class="route-main"><div><div class="name">${esc(r.name||r.id)}</div><div class="meta">驾驶员：${esc(findUser(r.driverUserId)?.name||'未绑定')} · 配送员：${esc(findUser(r.deliveryUserId)?.name||'未绑定')}</div></div><span class="badge">${esc(r.status||'active')}</span></div></article>`).join('')||'<div class="meta">暂无已登记路线</div>';
}
function fillSelects(){
  const options='<option value="">未绑定</option>'+users.filter(u=>u.status==='active'&&u.role!=='system_admin').map(u=>`<option value="${escAttr(u.id)}">${esc(u.name||u.username)} · ${esc(u.boundRouteId||'未绑定')}</option>`).join('');
  $('#driverSelect').innerHTML=options;$('#deliverySelect').innerHTML=options;
}
async function saveRoute(){
  const route=$('#routeInput').value.trim(),driverUserId=$('#driverSelect').value,deliveryUserId=$('#deliverySelect').value;
  if(!route){notice('请输入路线');return}
  try{const r=await api('/api/admin/routes',{method:'PUT',body:{route,driverUserId,deliveryUserId}});if(!r.success)throw new Error(r.error||'路线绑定失败');notice('路线绑定已保存');await Promise.all([loadUsers(),loadRoutes()])}catch(e){notice(e.message,true)}
}
async function resetPassword(id){const password=prompt('输入新的6-72位密码');if(!password)return;try{const r=await api('/api/admin/reset-password',{method:'POST',body:{userId:id,password}});if(!r.success)throw new Error(r.error);notice('密码已重置，旧设备会话已失效')}catch(e){notice(e.message,true)}}
async function toggleUser(id,status){try{const r=await api('/api/admin/users',{method:'PATCH',body:{userId:id,status}});if(!r.success)throw new Error(r.error);await loadUsers()}catch(e){notice(e.message,true)}}
async function setRole(id,role){try{const r=await api('/api/admin/users',{method:'PATCH',body:{userId:id,role}});if(!r.success)throw new Error(r.error);await loadUsers()}catch(e){notice(e.message,true)}}
function switchTab(tab){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
  $('#usersTab').classList.toggle('hidden',tab!=='users');
  $('#routesTab').classList.toggle('hidden',tab!=='routes');
  $('#logsTab').classList.toggle('hidden',tab!=='logs');
  $('#resetTab').classList.toggle('hidden',tab!=='reset');
}
async function resetData(){
  const key=$('#resetKey').value;
  const confirmation=$('#resetConfirmation').value.trim();
  if(!key){notice('请输入数据重置密钥',true);return}
  if(confirmation!=='确认清空智配One数据'){notice('确认文字不正确',true);return}
  if(!confirm('最后确认：这将删除全部智配One业务数据，包括当前管理员账号。确定继续？')) return;
  const btn=$('#resetDataBtn');
  btn.disabled=true;
  btn.textContent='正在清空…';
  $('#resetResult').classList.add('hidden');
  try{
    const r=await api('/api/admin/data-reset',{method:'POST',headers:{'X-Data-Reset-Key':key},body:{confirmation}});
    if(!r.success) throw new Error(r.error||'数据重置失败');
    $('#resetResult').textContent=`已清空：扫描 ${r.scanned||0} 个键，删除 ${r.deleted||0} 个键。请重新注册管理员并建立路线数据。`;
    $('#resetResult').classList.remove('hidden');
    notice('数据重置完成。当前管理员账号已删除，请重新注册。');
    $('#resetKey').value='';
    $('#resetConfirmation').value='';
  }catch(e){notice(e.message||'数据重置失败',true)}
  finally{btn.disabled=false;btn.textContent='清空全部智配One业务数据'}
}
function findUser(id){return users.find(u=>u.id===id)}
async function api(url,opt={}){const o={method:opt.method||'GET',headers:{'Content-Type':'application/json'}};if(opt.body)o.body=JSON.stringify(opt.body);const res=await fetch(url,o);const raw=await res.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}if(!res.ok){if(data&&data.error)throw new Error(`${url} HTTP ${res.status}：${data.error}`);throw new Error(`${url} HTTP ${res.status}：${raw.slice(0,160)||'服务器无响应内容'}`)}if(!data)throw new Error(`${url}：服务器返回非JSON响应`);return data}
function notice(msg,error=false){const n=$('#notice');n.textContent=msg;n.classList.remove('hidden');n.style.borderLeft=error?'3px solid var(--danger)':'3px solid var(--blue)'}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escAttr(v){return esc(v)}
