const Auth={
 async loginWithCredentials(type,account,password){const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({type,account,password})});let d=null;try{d=await r.json()}catch{}if(!r.ok||!d?.success){const e=new Error(d?.error||'账号或密码错误');e.status=r.status;throw e}const u=d.user||{},route=type==='admin'?'admin':this.formatRouteCode(u.route);this.login(route,u.name||(type==='admin'?'管理员':'司机'));if(d.sessionToken)localStorage.setItem('sessionToken',d.sessionToken);return u},
 getSessionToken(){return localStorage.getItem('sessionToken')||''},
 getAuthHeaders(extra={}){const h={...extra},t=this.getSessionToken();if(t)h.Authorization=`Bearer ${t}`;return h},
 async getUsers(){return this.fetchUsersFromUpstash()},
 async fetchUsersFromUpstash(){const r=await fetch('/api/users',{cache:'no-store',headers:this.getAuthHeaders()});if(!r.ok)throw Error(r.status===401?'管理员登录已失效':'用户数据读取失败');const d=await r.json();let u=d.users;if(typeof u==='string')u=JSON.parse(u);return Array.isArray(u)?u:[]},
 async saveUsersToUpstash(users){const r=await fetch('/api/users',{method:'POST',headers:this.getAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({users})});if(!r.ok)throw Error(r.status===401?'管理员登录已失效':'用户数据保存失败')},
 async saveUsers(users){return this.saveUsersToUpstash(users)},
 async findUserByRoute(route){const u=await this.getUsers(),f=this.formatRouteCode(route);return u.find(x=>x.route===f)||null},
 async findAdminByName(name){const u=await this.getUsers();return u.find(x=>x.role==='admin'&&x.name===name)||null},
 async isRouteRegistered(route){return!!(await this.findUserByRoute(route))},
 async createUser(route,password,role='driver',name=''){const f=this.formatRouteCode(route);if(await this.findUserByRoute(f))return null;const u=await this.getUsers(),id=u.reduce((m,x)=>Math.max(m,x.id||0),0)+1,n={id,name:name||'',route:f,password,role,createdAt:new Date().toISOString(),sessionVersion:1};u.push(n);await this.saveUsersToUpstash(u);return n},
 async updateUser(route,updates){const f=this.formatRouteCode(route),u=await this.getUsers(),i=u.findIndex(x=>x.route===f);if(i<0)return null;u[i]={...u[i],...updates};if(Object.prototype.hasOwnProperty.call(updates,'password'))u[i].sessionVersion=Number(u[i].sessionVersion||1)+1;await this.saveUsersToUpstash(u);return u[i]},
 async deleteUser(route){const f=this.formatRouteCode(route),u=(await this.getUsers()).filter(x=>x.route!==f);await this.saveUsersToUpstash(u)},
 // 业务数据禁止保存在浏览器。以下旧兼容方法不再读写 localStorage，调用方应使用服务器 API。
 getUserDataKey(route){return`server:${this.formatRouteCode(route)}`},
 getUserOrderData(){return null},
 saveUserOrderData(){return false},
 clearUserOrderData(){return true},
 checkAuth(){const ok=localStorage.getItem('loginStatus')==='true'&&localStorage.getItem('currentRoute')&&this.getSessionToken();if(ok)return true;const p=location.pathname.split('/').pop();if(['index.html','login.html',''].includes(p))return false;location.href=location.pathname.includes('/pages/')?'../index.html':'index.html';return false},
 getCurrentRoute(){return localStorage.getItem('currentRoute')||''},
 getCurrentUser(){return localStorage.getItem('currentUser')||'司机'},
 login(route,user='司机'){this.clearSessionCache();const f=route==='admin'?'admin':this.formatRouteCode(route);localStorage.setItem('loginStatus','true');localStorage.setItem('currentRoute',f);localStorage.setItem('currentUser',user)},
 logout(){this.clearSessionCache();['loginStatus','currentRoute','currentUser','sessionToken'].forEach(k=>localStorage.removeItem(k));location.href=location.pathname.includes('/pages/')?'../index.html':'index.html'},
 clearSessionCache(){['today_orders','history_view_data','base_data','delivery_history','today_vehicle','today_total_weight','today_order_date','today_order_source'].forEach(k=>localStorage.removeItem(k));const r=this.getCurrentRoute();if(r)localStorage.removeItem(`route_cache_${r}`)},
 // 以下旧读取接口保留名称，但不再从浏览器读取业务数据。
 getTodayOrders(){return null},
 getBaseData(){return null},
 getDeliveryHistory(){return null},
 getCachedRouteData(){return null},
 formatRouteCode(input){if(!input)return'';const c=String(input).trim(),m=c.match(/(\d+)号线/);if(m)return String(parseInt(m[1])).padStart(2,'0')+'号线';const n=c.match(/^(\d+)$/);if(n)return String(parseInt(n[1])).padStart(2,'0')+'号线';return c},
 isValidRouteCode(c){return/^\d{2,}号线$/.test(c)},
 async createRoute(route,password,role='driver',name=''){const f=this.formatRouteCode(route);if(!this.isValidRouteCode(f)||await this.findUserByRoute(f))return null;const u=await this.createUser(f,password,role,name);if(!u)return null;const stores=[{code:'01',name:'新门店_01',nav:''},{code:'02',name:'新门店_02',nav:''},{code:'03',name:'新门店_03',nav:''}];const r=await fetch(`/api/routes?route=${encodeURIComponent(f)}`,{method:'PUT',headers:this.getAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({stores})});if(!r.ok)throw Error('线路基准数据创建失败');return{route:f,stores,createdAt:new Date().toISOString()}},
 cacheRouteData(){return false},
 addLog(action,detail){console.info('日志由服务器管理：',action,detail)}
};
window.openUserManagement=async function(){const dialog=document.getElementById('userDialog'),list=document.getElementById('userList');if(dialog)dialog.classList.add('active');if(!list)return;list.innerHTML='<div class="admin-empty">⏳ 正在加载用户数据...</div>';try{const users=await Auth.getUsers();if(!users.length){list.innerHTML='<div class="admin-empty">暂无用户</div>';return}const roleMap={admin:'管理员',driver:'司机',delivery:'配送'},roleClass={admin:'admin',driver:'driver',delivery:'delivery'};list.innerHTML=users.sort((a,b)=>a.role==='admin'?-1:b.role==='admin'?1:(a.id||0)-(b.id||0)).map(u=>`<div class="admin-list-item"><div class="info"><div class="name">${String(u.name||'(未命名)').replace(/[&<>'"]/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[s]))}</div><div class="sub">${String(u.route||'')} · <span class="role-badge ${roleClass[u.role]||'driver'}">${roleMap[u.role]||'司机'}</span></div></div><div class="actions"><button class="edit-btn" onclick="editUser(${u.id})">编辑</button>${u.role==='admin'?'':`<button class="del-btn" onclick="deleteUser(${u.id})">删除</button>`}</div></div>`).join('')}catch(e){list.innerHTML=`<div class="admin-empty">加载失败：${String(e.message||e)}</div>`}};
document.addEventListener('DOMContentLoaded',()=>{const p=location.pathname.split('/').pop();if(!['index.html','login.html',''].includes(p))Auth.checkAuth()});window.Auth=Auth;
