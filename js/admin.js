const $=s=>document.querySelector(s);
const routeActionStyle=document.createElement('style');routeActionStyle.textContent='.person-line{display:grid;grid-template-columns:64px minmax(0,1fr) auto;align-items:center;gap:9px;padding:9px 10px;border-radius:10px;background:#141C24;border:1px solid rgba(255,255,255,.045)}.person-line span{color:var(--muted2);font-size:11px}.person-line strong{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bind-role,.subtle-danger{border:1px solid var(--line2);border-radius:9px;padding:7px 10px;background:#1A232D;color:#DDE3E8;font-size:11px;font-weight:600;white-space:nowrap}.subtle-danger{border-color:rgba(182,75,75,.25);background:#20181A;color:#C99595}.admin-user-select-list{display:grid;gap:6px;margin-top:14px;max-height:48vh;overflow:auto}.admin-user-option{display:grid;grid-template-columns:22px minmax(0,1fr);align-items:center;gap:9px;padding:10px 11px;border:1px solid rgba(255,255,255,.06);border-radius:11px;background:#101820;cursor:pointer}.admin-user-option input{margin:0}.admin-user-option-copy strong{display:block;font-size:13px}.admin-user-option-copy small{display:block;color:var(--muted2);font-size:10px;margin-top:1px}';document.head.appendChild(routeActionStyle);
let users=[];
let routes=[];
// 仅在当前管理员会话内保留刚创建的邀请码明文，便于再次点击“复制”；服务端列表仍只返回掩码。
const invitePlainCodes=new Map();

document.addEventListener('DOMContentLoaded', async ()=>{
  // 管理员身份校验必须先执行；任何管理页控件绑定异常都不能阻断管理员认证。
  await boot();
  try{
    document.querySelectorAll('.tab').forEach(btn=>btn.onclick=()=>switchTab(btn.dataset.tab));
    const bind=(id,event,handler)=>{
      const el=$('#'+id);
      if(!el) return;
      el.addEventListener(event,handler);
    };
    bind('refreshUsers','click',loadUsers);
    bind('refreshRoutes','click',loadRoutes);
    bind('showCreateRoute','click',()=>{$('#routeCreatePanel').classList.remove('hidden');$('#newRouteInput').focus();});
    bind('cancelCreateRoute','click',()=>$('#routeCreatePanel').classList.add('hidden'));
    bind('createRoute','click',createRoute);
    bind('refreshRequests','click',loadRequests);
    bind('refreshInvites','click',loadInvites);
    bind('showCreateInvite','click',()=>$('#inviteCreatePanel').classList.remove('hidden'));
    bind('cancelCreateInvite','click',()=>$('#inviteCreatePanel').classList.add('hidden'));
    bind('createInvite','click',createInvite);
    bind('refreshLogs','click',loadLogs);
    bind('resetDataBtn','click',resetData);
    bind('toggleResetKey','click',toggleResetKey);
  }catch(e){
    notice('管理员页面控件初始化异常：'+(e.message||'未知错误'),true);
  }
});

async function boot(){
  try{
    // 管理页是独立模式：只做一次服务器管理员身份校验，不进入业务认证链。
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(), 8000);
    let response;
    try{
      response = await fetch('/api/admin/session', { cache:'no-store', credentials:'same-origin', signal:controller.signal });
    }finally{
      clearTimeout(timeout);
    }
    const sessionData = await response.json().catch(()=>null);
    if(!response.ok || !sessionData?.success) throw new Error(sessionData?.error || '管理员会话验证失败，请重新登录');
    const me = sessionData.user;
    if(me?.role!=='system_admin'||me?.adminLevel!=='primary') throw new Error('当前账号不是主系统管理员');
    $('#adminUser').textContent=(me.name||me.username)+' · 主系统管理员';
    const results = await Promise.allSettled([loadUsers(), loadRoutes(), loadRequests(), loadInvites(), loadLogs()]);
    const failed = results.filter(x => x.status === 'rejected');
    if (failed.length) notice(`管理接口异常：${failed.map(x => x.reason?.message || '未知错误').join('；')}`, true);
  }catch(e){
    const message=e?.name==='AbortError'?'管理员会话验证超时（8秒），请检查登录会话或刷新页面':(e.message||'管理员身份验证失败');
    const el=$('#adminUser');
    if(el) el.textContent=message;
    notice(message,true);
  }
}
window.addEventListener('zhipei-auth-failed', event => {
  const message = event.detail?.message || '管理员会话验证失败';
  const el = $('#adminUser');
  if (el) el.textContent = message + '，请重新登录';
  notice(message, true);
});
async function loadUsers(){
  try{const r=await api('/api/admin/users'); if(!r.success) throw new Error(r.error||'用户读取失败'); users=r.users||[]; renderUsers();}catch(e){notice(e.message,true)}
}
async function createRoute(){
  const input=$('#newRouteInput'); const route=input.value.trim();
  if(!route){notice('请输入线路，例如 17号线',true);return}
  const button=$('#createRoute'); button.disabled=true; button.textContent='创建中…';
  try{const r=await api('/api/admin/routes',{method:'POST',body:{route}});if(!r.success)throw new Error(r.error||'线路创建失败');input.value='';$('#routeCreatePanel').classList.add('hidden');notice('线路 '+r.route.name+' 已创建');await loadRoutes()}catch(e){notice(e.message||'线路创建失败',true)}finally{button.disabled=false;button.textContent='创建线路'}
}
async function loadRoutes(){
  try{
    const r=await api('/api/admin/routes');
    if(!r.success) throw new Error(r.error||'线路读取失败');
    routes=r.routes||[];
    renderRoutes();
    // 线路与用户列表存在交叉身份信息；线路刷新后同步重绘用户身份，避免并行加载造成旧显示。
    if(users.length) renderUsers();
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
  if(!await OneModal.confirm(`确定${label}该线路绑定申请吗？`,{title:'线路绑定申请',confirmText:label,danger:action==='reject'}))return;
  try{
    const r=await api('/api/admin/route-requests',{method:'PATCH',body:{requestId:id,action}});
    if(!r.success)throw new Error(r.error||'审核失败');
    notice(`线路绑定申请已${label}`);
    await Promise.all([loadRequests(),loadUsers(),loadRoutes()]);
  }catch(e){notice(e.message,true)}
}
async function loadInvites(){
  try{
    const r=await api('/api/admin/invites'); if(!r.success) throw new Error(r.error||'邀请码读取失败');
    renderInvites(r.invites||[]);
  }catch(e){notice(e.message,true);throw e}
}
async function createInvite(){
  const button=$('#createInvite'); button.disabled=true; button.textContent='创建中…';
  try{
    const r=await api('/api/admin/invites',{method:'POST',body:{maxUses:$('#inviteUses').value,expiresIn:$('#inviteExpiry').value}});
    if(!r.success) throw new Error(r.error||'邀请码创建失败');
    $('#inviteCreatePanel').classList.add('hidden'); await loadInvites();
    const code=r.invite?.code||'';
    const hash=r.invite?.hash||'';
    if(code&&hash) invitePlainCodes.set(String(hash),String(code));
    if(code){ const copied=await navigator.clipboard?.writeText(code).then(()=>true).catch(()=>false); await OneModal.alert('邀请码：'+code+(copied?'\\n\\n已自动复制。':'\\n\\n请点击“复制”保存；出于安全考虑，刷新后不会再次显示完整明文。'),{title:'邀请码已创建'}); }
    else notice('邀请码已创建');
  }catch(e){notice(e.message||'邀请码创建失败',true)}
  finally{button.disabled=false;button.textContent='创建邀请码'}
}
function renderInvites(list){
  $('#inviteList').innerHTML=list.map(x=>{
    const uses=x.maxUses===0?'不限':(x.usedCount+'/'+x.maxUses+' 次');
    const expiry=x.expiresAt?new Date(x.expiresAt).toLocaleDateString('zh-CN'):'永久';
    const label=x.status==='active'?'有效':x.status==='exhausted'?'已用完':x.status==='expired'?'已过期':'已停用';
    const hash=String(x.hash||'');
    if(x.code) invitePlainCodes.set(hash,String(x.code));
    const copyAction='<button class="copy-invite-btn" onclick="copyInviteCode(\''+escAttr(hash)+'\',this)">复制</button>';
    const action=x.status==='active'?copyAction+'<button onclick="setInviteStatus(\''+escAttr(hash)+'\',\'disabled\')">停用</button>':copyAction;
    return '<article class="invite-card"><div class="invite-main"><div><div class="name">邀请码 '+esc(x.maskedCode||'••••-••••')+'</div><div class="meta">'+esc(uses)+' · '+esc(expiry)+'</div></div><span class="badge">'+esc(label)+'</span></div><div class="meta">创建：'+esc(x.createdAt||'')+(x.lastUsedAt?' · 最后使用：'+esc(x.lastUsedAt):'')+'</div><div class="actions">'+action+'</div></article>';
  }).join('')||'<div class="empty-state">暂无邀请码</div>';
}
async function copyInviteCode(hash,button){
  const code=invitePlainCodes.get(String(hash));
  if(!code){
    if(button){button.textContent='不可复制';setTimeout(()=>{button.textContent='复制'},1400)}
    return;
  }
  const restore=()=>{
    if(!button) return;
    button.textContent='复制';
    button.disabled=false;
  };
  try{
    await navigator.clipboard.writeText(code);
    if(button){
      button.textContent='✓ 已复制';
      button.disabled=true;
      setTimeout(restore,1600);
    }
  }catch(e){
    if(button){
      button.textContent='复制失败';
      setTimeout(restore,1600);
    }
  }
}
async function setInviteStatus(hash,status){
  if(!await OneModal.confirm('确定停用这个邀请码吗？停用后无法继续注册使用。',{title:'停用邀请码',confirmText:'停用',danger:true})) return;
  try{ const r=await api('/api/admin/invites',{method:'PATCH',body:{hash,status}}); if(!r.success) throw new Error(r.error||'操作失败'); notice('邀请码已停用'); await loadInvites(); }catch(e){notice(e.message||'操作失败',true)}
}
async function loadLogs(){
  const endpoint='/api/admin/logs';
  try{
    const r=await api(endpoint);
    if(!r.success) throw new Error(`${endpoint}：${r.error||'日志读取失败'}`);
    $('#logList').innerHTML=(r.logs||[]).map(renderAdminLog).join('')||'<div class="meta">暂无日志</div>';
    return true;
  }catch(e){notice(e.message,true);throw e}
}
function renderAdminLog(x){
  const action=String(x.action||'');
  const labels={
    create_route:'新建线路',
    repair_route_record:'修复线路信息',
    bind_route:'绑定线路人员',
    unbind_route:'解除线路绑定',
    create_user:'创建用户',
    update_user:'修改用户信息',
    delete_user:'删除用户',
    reset_password:'重置密码',
    create_invite:'创建邀请码',
    update_invite:'更新邀请码',
    disable_invite:'停用邀请码',
    enable_invite:'启用邀请码',
    approve_route_request:'通过线路绑定申请',
    reject_route_request:'拒绝线路绑定申请',
    delete_history:'删除历史运单',
    data_reset:'系统数据重置'
  };
  const targetLabels={user:'用户',route:'线路',route_request:'绑定申请',invite:'邀请码',history:'历史运单',system:'系统'};
  const title=labels[action]||action||'系统操作';
  const targetType=targetLabels[String(x.targetType||'')]||String(x.targetType||'操作');
  const targetId=String(x.targetId||'');
  const detail=x.detail&&typeof x.detail==='object'?x.detail:{};
  let description='';
  if(action==='create_route'||action==='repair_route_record') description=`线路：${targetId}`;
  else if(action==='bind_route') description=`线路：${targetId}${detail.driverUserId?' · 驾驶员已配置':''}${detail.deliveryUserId?' · 配送员已配置':''}`;
  else if(action==='delete_user') description=`用户：${detail.username||targetId}`;
  else if(action==='reset_password'||action==='update_user') description=`用户：${detail.username||targetId}`;
  else if(action==='approve_route_request'||action==='reject_route_request') description=`申请线路：${detail.route||targetId}`;
  else if(action==='create_invite'||action==='update_invite') description='邀请码管理';
  else if(action==='delete_history') description=`历史运单：${targetId}`;
  else if(targetId) description=`${targetType}：${targetId}`;
  const actor=x.actorName||x.actorUsername||'管理员';
  const time=formatAdminLogTime(x.createdAt);
  return `<article class="route-card admin-log-card"><div class="name">${esc(title)}</div><div class="meta">${esc(description)}</div><div class="meta">${esc(actor)} · ${esc(time)}</div></article>`;
}
function formatAdminLogTime(value){
  const s=String(value||'').trim();
  if(!s) return '';
  const d=new Date(s);
  if(Number.isNaN(d.getTime())) return s;
  const pad=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
}
function renderUsers(){
  $('#userCount').textContent=users.length+' 个账号';
  const orderedUsers=[...users].sort((a,b)=>(a?.adminLevel==='primary'?0:1)-(b?.adminLevel==='primary'?0:1));
  $('#userList').innerHTML=orderedUsers.map(u=>{
    const route=routes.find(r=>String(r.driverUserId||'')===String(u.id))||routes.find(r=>String(r.deliveryUserId||'')===String(u.id));
    const duty=String(u.routeDuty||'').toLowerCase();
    const inferredDuty=duty==='driver'||duty==='delivery'?duty:route&&String(route.driverUserId||'')===String(u.id)?'driver':route&&String(route.deliveryUserId||'')===String(u.id)?'delivery':'';
    const roleText=u.adminLevel==='primary'?'主系统管理员':inferredDuty==='driver'?'驾驶员':inferredDuty==='delivery'?'配送员':'业务用户';
    const bindingText=u.adminLevel==='primary'?'角色：主系统管理员':'角色：'+roleText+' · 绑定：'+(route?.id||u.boundRouteId||'未绑定');
    const actions=u.adminLevel==='primary'?'':`<button onclick="resetPassword('${escAttr(u.id)}')">重置密码</button><button onclick="deleteUser('${escAttr(u.id)}')">删除账号</button>`;
    return `<article class="user-card"><div class="user-main"><div><div class="name">${esc(u.name||u.username)}</div><div class="meta">${esc(u.username)} · ${esc(u.id)}</div></div><span class="badge">${esc(u.adminLevel==='primary'?'主系统管理员':'正常')}</span></div><div class="meta">${esc(bindingText)}</div><div class="actions">${actions}</div></article>`;
  }).join('')||'<div class="meta">暂无用户</div>';
}
function renderRoutes(){
  $('#routeList').innerHTML=routes.map(r=>{
    const driver=findUser(r.driverUserId);
    const delivery=findUser(r.deliveryUserId);
    const roleRow=(label,user,duty)=>{
      if(user) return '<div class="person-line"><span>'+esc(label)+'：</span><strong>'+esc(user.name||user.username)+'</strong><button class="subtle-danger" type="button" onclick="unbindRouteRole(\''+escAttr(r.id||r.name)+'\',\''+duty+'\',\''+escAttr(user.id)+'\')">解绑</button></div>';
      return '<div class="person-line"><span>'+esc(label)+'：</span><strong>未绑定</strong><button class="bind-role" type="button" onclick="bindRouteRole(\''+escAttr(r.id||r.name)+'\',\''+duty+'\')">绑定</button></div>';
    };
    return '<article class="route-card"><div class="route-card-head"><div><div class="name">'+esc(r.name||r.id)+'</div></div></div><div class="route-people">'+roleRow('驾驶员',driver,'driver')+roleRow('配送员',delivery,'delivery')+'</div></article>';
  }).join('')||'<div class="empty-state">暂无已登记线路</div>';
}
function availableUsers(){
  return users.filter(u=>u.status==='active'&&u.role!=='system_admin'&&!String(u.boundRouteId||'').trim());
}
async function bindRouteRole(routeId,duty){
  const route=routes.find(x=>String(x.id||x.name)===String(routeId));
  if(!route)return;
  const list=availableUsers();
  if(!list.length){await OneModal.notice('暂无未绑定用户',{title:duty==='driver'?'选择驾驶员':'选择配送员'});return;}
  const selected=await selectUnboundUser(duty==='driver'?'选择驾驶员':'选择配送员',list);
  if(!selected)return;
  const body={route:route.id||route.name,driverUserId:String(route.driverUserId||''),deliveryUserId:String(route.deliveryUserId||'')};
  if(duty==='driver')body.driverUserId=selected;else body.deliveryUserId=selected;
  if(body.driverUserId&&body.deliveryUserId&&body.driverUserId===body.deliveryUserId){notice('同一用户不能同时担任驾驶员和配送员',true);return;}
  try{const r=await api('/api/admin/routes',{method:'PUT',body});if(!r.success)throw new Error(r.error||'绑定失败');notice('绑定成功');await Promise.all([loadUsers(),loadRoutes()]);}catch(e){notice(e.message||'绑定失败',true)}
}
function selectUnboundUser(title,list){
  return new Promise(resolve=>{
    const overlay=document.createElement('div');overlay.className='one-shared-dialog';overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');
    const box=document.createElement('section');box.className='one-shared-dialog__box';
    const head=document.createElement('div');head.className='one-shared-dialog__head';head.innerHTML='<div class="one-shared-dialog__title"></div><button type="button" class="one-shared-dialog__close" aria-label="关闭">×</button>';
    head.querySelector('.one-shared-dialog__title').textContent=title;box.appendChild(head);
    const listEl=document.createElement('div');listEl.className='admin-user-select-list';
    let selected='';
    list.forEach(u=>{
      const label=document.createElement('label');label.className='admin-user-option';
      label.innerHTML='<input type="radio" name="admin-bind-user"><span class="admin-user-option-copy"><strong></strong><small>未绑定</small></span>';
      label.querySelector('input').value=String(u.id);label.querySelector('strong').textContent=u.name||u.username;
      label.querySelector('input').addEventListener('change',()=>{selected=String(u.id);confirm.disabled=false});
      listEl.appendChild(label);
    });
    box.appendChild(listEl);
    const actions=document.createElement('div');actions.className='one-shared-dialog__actions';
    const cancel=document.createElement('button');cancel.type='button';cancel.className='one-shared-dialog__secondary';cancel.textContent='取消';
    const confirm=document.createElement('button');confirm.type='button';confirm.className='one-shared-dialog__primary';confirm.textContent='确定';confirm.disabled=true;
    actions.append(cancel,confirm);box.appendChild(actions);overlay.appendChild(box);document.body.appendChild(overlay);
    const finish=v=>{overlay.remove();resolve(v)};
    cancel.onclick=()=>finish(null);head.querySelector('.one-shared-dialog__close').onclick=()=>finish(null);confirm.onclick=()=>finish(selected);
  });
}
async function unbindRouteRole(routeId,duty,userId){
  const route=routes.find(x=>String(x.id||x.name)===String(routeId));if(!route)return;
  const user=findUser(userId);if(!user)return;
  const dutyName=duty==='driver'?'驾驶员':'配送员';
  if(!await OneModal.confirm('确定解除“'+(user.name||user.username)+'”的'+dutyName+'绑定？',{title:'解除绑定',confirmText:'确定',danger:true}))return;
  const body={route:route.id||route.name,driverUserId:String(route.driverUserId||''),deliveryUserId:String(route.deliveryUserId||'')};
  if(duty==='driver')body.driverUserId='';else body.deliveryUserId='';
  try{const r=await api('/api/admin/routes',{method:'PUT',body});if(!r.success)throw new Error(r.error||'解除绑定失败');notice('已解除绑定');await Promise.all([loadUsers(),loadRoutes()]);}catch(e){notice(e.message||'解除绑定失败',true)}
}
async function resetPassword(id){const password=await OneModal.prompt('输入新的6-72位密码',{title:'重置密码',placeholder:'6-72位密码',password:true,confirmText:'重置'});if(!password)return;try{const r=await api('/api/admin/reset-password',{method:'POST',body:{userId:id,password}});if(!r.success)throw new Error(r.error);notice('密码已重置，旧设备会话已失效')}catch(e){notice(e.message,true)}}
async function toggleUser(id,status){try{const r=await api('/api/admin/users',{method:'PATCH',body:{userId:id,status}});if(!r.success)throw new Error(r.error);await loadUsers()}catch(e){notice(e.message,true)}}
async function deleteUser(id){
  const user=users.find(x=>x.id===id);
  if(!user)return;
  if(user.role==='system_admin'){notice('不能删除系统管理员账号',true);return}
  if(user.boundRouteId){notice('该用户已绑定线路，请先解除绑定',true);return}
  if(!await OneModal.confirm('确定删除账号“'+user.username+'”吗？删除后账号及登录索引将永久移除。',{title:'删除账号',confirmText:'删除',danger:true}))return;
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
  $('#invitesTab').classList.toggle('hidden',tab!=='invites');
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
  if(!await OneModal.confirm('最后确认：这将清除全部智配One业务数据，仅保留原始主系统管理员账号。确定继续？',{title:'清空业务数据',confirmText:'继续清空',danger:true})) return;
  const btn=$('#resetDataBtn');
  btn.disabled=true;
  btn.textContent='正在清空…';
  $('#resetResult').classList.add('hidden');
  try{
    const r=await api('/api/admin/data-reset',{method:'POST',headers:{'X-Data-Reset-Key':key},body:{confirmation}});
    if(!r.success) throw new Error(r.error||'数据重置失败');
    $('#resetResult').textContent=`已清空：扫描 ${r.scanned||0} 个键，删除 ${r.deleted||0} 个键。请保留现有主系统管理员账号，重新建立线路和基准库。`;
    $('#resetResult').classList.remove('hidden');
    notice('数据重置完成。主系统管理员账号已保留，可继续进行系统管理。');
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
