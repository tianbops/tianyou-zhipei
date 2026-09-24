const $=s=>document.querySelector(s);
let users=[];
let routes=[];

document.addEventListener('DOMContentLoaded', async ()=>{
  document.querySelectorAll('.tab').forEach(btn=>btn.onclick=()=>switchTab(btn.dataset.tab));
  $('#refreshUsers').onclick=loadUsers;
  $('#refreshRoutes').onclick=loadRoutes;
  $('#showCreateRoute').onclick=()=>{$('#routeCreatePanel').classList.remove('hidden');$('#newRouteInput').focus();};
  $('#cancelCreateRoute').onclick=()=>$('#routeCreatePanel').classList.add('hidden');
  $('#createRoute').onclick=createRoute;
  $('#cancelRouteEdit').onclick=closeRouteEditor;
  $('#refreshRequests').onclick=loadRequests;
  $('#refreshLogs').onclick=loadLogs;
  $('#resetDataBtn').onclick=resetData;
  $('#toggleResetKey').onclick=()=>toggleResetKey();
  $('#saveRoute').onclick=saveRoute;
  $('#backBtn').onclick=()=>{
    const ref=document.referrer;
    let sameOrigin=false;
    try{sameOrigin=!!ref&&new URL(ref,location.href).origin===location.origin&&new URL(ref,location.href).pathname!==location.pathname}catch(_){}
    if(sameOrigin&&history.length>1){history.back();return}
    location.replace('home.html');
  };
  await boot();
});

async function boot(){
  try{
    const me=await api('/api/me');
    if(!me.success||me.user?.role!=='system_admin') throw new Error('当前账号没有系统管理权限');
    $('#adminUser').textContent=(me.user.name||me.user.username)+' · '+(me.user.adminLevel==='primary'?'主系统管理员':'系统管理员');
    const results = await Promise.allSettled([loadUsers(), loadRoutes(), loadRequests(), loadLogs()]);
    const failed = results.filter(x => x.status === 'rejected');
    if (failed.length) notice(`管理接口异常：${failed.map(x => x.reason?.message || '未知错误').join('；')}`, true);
  }catch(e){notice(e.message||'管理员身份验证失败',true)}
}
async function loadUsers(){
  try{const r=await api('/api/admin/users'); if(!r.success) throw new Error(r.error||'用户读取失败'); users=r.users||[]; renderUsers(); fillSelects()}catch(e){notice(e.message,true)}
}
async function createRoute(){
  const input=$('#newRouteInput'); const route=input.value.trim();
  if(!route){notice('请输入线路，例如 17号线',true);return}
  const button=$('#createRoute'); button.disabled=true; button.textContent='创建中…';
  try{const r=await api('/api/admin/routes',{method:'POST',body:{route}});if(!r.success)throw new Error(r.error||'线路创建失败');input.value='';$('#routeCreatePanel').classList.add('hidden');notice('线路 '+r.route.name+' 已创建');await loadRoutes();fillSelects()}catch(e){notice(e.message||'线路创建失败',true)}finally{button.disabled=false;button.textContent='创建线路'}
}
async function loadRoutes(){
  try{
    const r=await api('/api/admin/routes');
    if(!r.success) throw new Error(r.error||'线路读取失败');
    routes=r.routes||[];
    renderRoutes();
    // 路线列表与下拉选择必须使用同一份最新数据，避免并发加载时下拉框停留在旧列表。
    fillSelects();
  }catch(e){notice(e.message,true)}
}
async function loadRequests(){
  const endpoint='/api/admin/route-requests';
  try{
    const r=await api(endpoint); if(!r.success) throw new Error(r.error||'申请读取失败');
    const list=r.requests||[];
    $('#requestList').innerHTML=list.map(x=>`<article class="route-card"><div class="route-main"><div><div class="name">${esc(x.name||x.username||'用户')}</div><div class="meta">${esc(x.username||'')} · 申请：${esc(x.route)} · 身份：${esc(x.duty==='driver'?'驾驶员':'配送员')}</div></div><span class="badge">待审核</span></div><div class="meta">${esc(x.createdAt||'')}</div><div class="actions"><button onclick="reviewRouteRequest('${escAttr(x.id)}','approve')">通过</button><button onclick="reviewRouteRequest('${escAttr(x.id)}','reject')">拒绝</button></div></article>`).join('')||'<div class="meta">暂无待审核申请</div>';
    return true;
  }catch(e){notice(e.message,true); throw e}
}
async function reviewRouteRequest(id,action){
  const label=action==='approve'?'通过':'拒绝';
  if(!confirm(`确定${label}该线路绑定申请吗？`))return;
  try{
    const r=await api('/api/admin/route-requests',{method:'PATCH',body:{requestId:id,action}});
    if(!r.success)throw new Error(r.error||'审核失败');
    notice(`线路绑定申请已${label}`);
    await Promise.all([loadRequests(),loadUsers(),loadRoutes()]);
  }catch(e){notice(e.message,true)}
}
async function loadLogs(){
  const endpoint='/api/admin/logs';
  try{const r=await api(endpoint);if(!r.success)throw new Error(`${endpoint}：${r.error||'日志读取失败'}`);$('#logList').innerHTML=(r.logs||[]).map(x=>`<article class="route-card"><div class="name">${esc(x.action)}</div><div class="meta">${esc(x.createdAt)} · ${esc(x.targetType)} · ${esc(x.targetId)}</div></article>`).join('')||'<div class="meta">暂无日志</div>'; return true}
  catch(e){notice(e.message,true); throw e}}
function renderUsers(){
  $('#userCount').textContent=users.length+' 个账号';
  const orderedUsers=[...users].sort((a,b)=>(a?.adminLevel==='primary'?0:a?.role==='system_admin'?1:2)-(b?.adminLevel==='primary'?0:b?.role==='system_admin'?1:2));
  $('#userList').innerHTML=orderedUsers.map(u=>`<article class="user-card">
    <div class="user-main"><div><div class="name">${esc(u.name||u.username)}</div><div class="meta">${esc(u.username)} · ${esc(u.id)}</div></div><span class="badge">${esc(u.adminLevel==='primary'?'主系统管理员':u.status==='active'?'正常':'停用')}</span></div>
    <div class="meta">角色：${esc(u.role)} · 绑定：${esc(u.boundRouteId||'未绑定')} ${u.routeDuty?'· '+esc(u.routeDuty):''}</div>
    <div class="actions">
      <button onclick="toggleUser('${escAttr(u.id)}','${u.status==='active'?'disabled':'active'}')">${u.status==='active'?'停用':'启用'}</button>
      <button onclick="resetPassword('${escAttr(u.id)}')">重置密码</button>
      <button onclick="setRole('${escAttr(u.id)}','${u.role==='system_admin'?'driver':'system_admin'}')">${u.adminLevel==='primary'?'主系统管理员':u.role==='system_admin'?'取消管理员':'设为管理员'}</button>
      ${u.role!=='system_admin'&&!u.boundRouteId?'<button onclick="deleteUser(\''+escAttr(u.id)+'\')">删除账号</button>':''}
    </div>
  </article>`).join('')||'<div class="meta">暂无用户</div>';
}
function renderRoutes(){
  $('#routeList').innerHTML=routes.map(r=>{
    const driver=findUser(r.driverUserId)?.name||'未绑定';
    const delivery=findUser(r.deliveryUserId)?.name||'未绑定';
    return `<article class="route-card">
      <div class="route-card-head"><div><div class="name">${esc(r.name||r.id)}</div><div class="route-id">${esc(r.id||'')}</div></div><button class="route-manage" type="button" onclick="openRouteEditor('${escAttr(r.id||r.name)}')">管理人员配置</button></div>
      <div class="route-people">
        <div class="person-line"><span>驾驶员</span><strong>${esc(driver)}</strong></div>
        <div class="person-line"><span>配送员</span><strong>${esc(delivery)}</strong></div>
      </div>
    </article>`;
  }).join('')||'<div class="empty-state">暂无已登记线路</div>';
}
function openRouteEditor(routeId){
  const route=routes.find(x=>String(x.id||x.name)===String(routeId));
  if(!route)return;
  fillSelects();
  $('#routeInput').value=route.id||route.name||'';
  $('#routeEditName').textContent=route.name||route.id||'';
  $('#driverSelect').value=route.driverUserId||'';
  $('#deliverySelect').value=route.deliveryUserId||'';
  $('#routeEditPanel').classList.remove('hidden');
  $('#routeEditPanel').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function closeRouteEditor(){
  $('#routeEditPanel').classList.add('hidden');
}
function fillSelects(){
  const options='<option value="">未绑定</option>'+users.filter(u=>u.status==='active'&&u.role!=='system_admin').map(u=>`<option value="${escAttr(u.id)}">${esc(u.name||u.username)} · ${esc(u.boundRouteId||'未绑定')}</option>`).join('');
  $('#driverSelect').innerHTML=options;$('#deliverySelect').innerHTML=options;
  const routeOptions='<option value="">选择线路</option>'+routes.map(r=>`<option value="${escAttr(r.id||r.name)}">${esc(r.name||r.id)}</option>`).join('');
  $('#routeInput').innerHTML=routeOptions;
}
async function saveRoute(){
  const route=$('#routeInput').value.trim(),driverUserId=$('#driverSelect').value,deliveryUserId=$('#deliverySelect').value;
  if(!route){notice('请选择线路');return}
  try{const r=await api('/api/admin/routes',{method:'PUT',body:{route,driverUserId,deliveryUserId}});if(!r.success)throw new Error(r.error||'线路绑定失败');notice('线路人员配置已保存');closeRouteEditor();await Promise.all([loadUsers(),loadRoutes()])}catch(e){notice(e.message,true)}
}
async function resetPassword(id){const password=prompt('输入新的6-72位密码');if(!password)return;try{const r=await api('/api/admin/reset-password',{method:'POST',body:{userId:id,password}});if(!r.success)throw new Error(r.error);notice('密码已重置，旧设备会话已失效')}catch(e){notice(e.message,true)}}
async function toggleUser(id,status){try{const r=await api('/api/admin/users',{method:'PATCH',body:{userId:id,status}});if(!r.success)throw new Error(r.error);await loadUsers()}catch(e){notice(e.message,true)}}
async function setRole(id,role){try{const r=await api('/api/admin/users',{method:'PATCH',body:{userId:id,role}});if(!r.success)throw new Error(r.error);await loadUsers()}catch(e){notice(e.message,true)}}
async function deleteUser(id){
  const user=users.find(x=>x.id===id);
  if(!user)return;
  if(user.role==='system_admin'){notice('不能删除系统管理员账号',true);return}
  if(user.boundRouteId){notice('该用户已绑定线路，请先解除绑定',true);return}
  if(!confirm('确定删除账号“'+user.username+'”吗？删除后账号及登录索引将永久移除。'))return;
  try{
    const r=await api('/api/admin/users',{method:'DELETE',body:{userId:id}});
    if(!r.success)throw new Error(r.error||'账号删除失败');
    notice('账号已删除');
    await loadUsers();
  }catch(e){notice(e.message||'账号删除失败',true)}
}
function switchTab(tab){
  document.querySelectorAll('.tab').forEach(x=>x.classList.toggle('active',x.dataset.tab===tab));
  $('#usersTab').classList.toggle('hidden',tab!=='users');
  $('#routesTab').classList.toggle('hidden',tab!=='routes');
  $('#logsTab').classList.toggle('hidden',tab!=='logs');
  $('#requestsTab').classList.toggle('hidden',tab!=='requests');
  $('#resetTab').classList.toggle('hidden',tab!=='reset');
}
function toggleResetKey(){
  const input=$('#resetKey');
  const btn=$('#toggleResetKey');
  const visible=input.type==='text';
  input.type=visible?'password':'text';
  btn.textContent=visible?'显示':'隐藏';
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
    $('#resetResult').textContent=`已清空：扫描 ${r.scanned||0} 个键，删除 ${r.deleted||0} 个键。请重新注册管理员并建立线路数据。`;
    $('#resetResult').classList.remove('hidden');
    notice('数据重置完成。当前管理员账号已删除，请重新注册。');
    $('#resetKey').value='';
    $('#resetConfirmation').value='';
  }catch(e){notice(e.message||'数据重置失败',true)}
  finally{btn.disabled=false;btn.textContent='清空全部智配One业务数据'}
}
function findUser(id){return users.find(u=>u.id===id)}
async function api(url,opt={}){const o={method:opt.method||'GET',headers:{'Content-Type':'application/json',...(opt.headers||{})},credentials:'same-origin',cache:'no-store'};if(opt.body)o.body=JSON.stringify(opt.body);const res=await fetch(url,o);const raw=await res.text();let data=null;try{data=raw?JSON.parse(raw):null}catch{}if(!res.ok){if(data&&data.error)throw new Error(`${url} HTTP ${res.status}：${data.error}`);throw new Error(`${url} HTTP ${res.status}：${raw.slice(0,160)||'服务器无响应内容'}`)}if(!data)throw new Error(`${url}：服务器返回非JSON响应`);return data}
function notice(msg,error=false){const n=$('#notice');n.textContent=msg;n.classList.remove('hidden');n.style.borderLeft=error?'3px solid var(--danger)':'3px solid var(--blue)'}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function escAttr(v){return esc(v)}
