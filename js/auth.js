// js/auth.js
// 统一认证与本地数据层
const Auth = {
  async loginWithCredentials(type, account, password) {
    const response = await fetch('/api/login', { method:'POST', headers:{'Content-Type':'application/json'}, cache:'no-store', body:JSON.stringify({type,account,password}) });
    let data=null; try{data=await response.json();}catch{}
    if(!response.ok || !data?.success){const e=new Error(data?.error||'账号或密码错误');e.status=response.status;throw e;}
    const user=data.user||{};
    const route=type==='admin'?'admin':this.formatRouteCode(user.route);
    this.login(route,user.name||(type==='admin'?'管理员':'司机'));
    localStorage.setItem('currentUserRole',user.role||(type==='admin'?'admin':'driver'));
    if(data.sessionToken)localStorage.setItem('sessionToken',data.sessionToken);
    return user;
  },
  getSessionToken(){return localStorage.getItem('sessionToken')||'';},
  getAuthHeaders(extra={}){const h={...extra};const t=this.getSessionToken();if(t)h.Authorization=`Bearer ${t}`;return h;},
  async getUsers(){try{const remote=await this.fetchUsersFromUpstash();if(remote){localStorage.setItem('admin_users',JSON.stringify(remote));return remote;}}catch(e){console.warn('获取用户数据失败，使用本地缓存');}return this.getLocalUsers();},
  getLocalUsers(){try{const d=localStorage.getItem('admin_users');return d?JSON.parse(d):[];}catch{return[];}},
  async fetchUsersFromUpstash(){const r=await fetch('/api/users',{cache:'no-store',headers:this.getAuthHeaders()});if(!r.ok)throw new Error('Failed to fetch users');const d=await r.json();let u=d.users;if(typeof u==='string')u=JSON.parse(u);return Array.isArray(u)?u:[];},
  async saveUsersToUpstash(users){const r=await fetch('/api/users',{method:'POST',headers:this.getAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({users})});if(!r.ok)throw new Error('Failed to save users');},
  async findUserByRoute(route){const users=await this.getUsers();const f=this.formatRouteCode(route);return users.find(u=>u.route===f)||null;},
  async findAdminByName(name){const users=await this.getUsers();return users.find(u=>u.role==='admin'&&u.name===name)||null;},
  async isRouteRegistered(route){return(await this.findUserByRoute(route))!==null;},
  async createUser(route,password,role='driver',name=''){const f=this.formatRouteCode(route);if(await this.findUserByRoute(f))return null;const users=await this.getUsers();const maxId=users.reduce((m,u)=>Math.max(m,u.id||0),0);const n={id:maxId+1,name:name||'',route:f,password,role,createdAt:new Date().toISOString()};users.push(n);await this.saveUsers(users);this.addLog('用户注册',`新用户注册: ${f} (${role})`);return n;},
  async updateUser(route,updates){const f=this.formatRouteCode(route);const users=await this.getUsers();const i=users.findIndex(u=>u.route===f);if(i===-1)return null;users[i]={...users[i],...updates};await this.saveUsers(users);this.addLog('用户更新',`更新用户: ${f}`);return users[i];},
  async deleteUser(route){const f=this.formatRouteCode(route);let users=await this.getUsers();users=users.filter(u=>u.route!==f);await this.saveUsers(users);this.addLog('用户删除',`删除用户: ${f}`);},
  getUserDataKey(route){return`user_data_${this.formatRouteCode(route)}`;},
  getUserOrderData(route){try{const d=localStorage.getItem(this.getUserDataKey(route));return d?JSON.parse(d):null;}catch{return null;}},
  saveUserOrderData(route,data){localStorage.setItem(this.getUserDataKey(route),JSON.stringify(data));},
  clearUserOrderData(route){localStorage.removeItem(this.getUserDataKey(route));},
  checkAuth(){const ok=localStorage.getItem('loginStatus')==='true'&&localStorage.getItem('currentRoute')&&this.getSessionToken();if(ok)return true;const p=window.location.pathname.split('/').pop();if(['index.html','login.html',''].includes(p))return false;window.location.href=window.location.pathname.includes('/pages/')?'../index.html':'index.html';return false;},
  getCurrentRoute(){return localStorage.getItem('currentRoute')||'';},
  getCurrentUser(){return localStorage.getItem('currentUser')||'司机';},
  login(route,user='司机'){this.clearSessionCache();const f=route==='admin'?'admin':this.formatRouteCode(route);localStorage.setItem('loginStatus','true');localStorage.setItem('currentRoute',f);localStorage.setItem('currentUser',user);const d=this.getUserOrderData(f);if(d){if(d.today_orders)localStorage.setItem('today_orders',JSON.stringify(d.today_orders));if(d.today_vehicle)localStorage.setItem('today_vehicle',d.today_vehicle);if(d.base_data)localStorage.setItem('base_data',JSON.stringify(d.base_data));if(d.delivery_history)localStorage.setItem('delivery_history',JSON.stringify(d.delivery_history);if(d.route_cache)localStorage.setItem(`route_cache_${f}`,JSON.stringify(d.route_cache));}},
  logout(){const r=this.getCurrentRoute();if(r)this.saveUserOrderData(r,{today_orders:this.getTodayOrders(),today_vehicle:localStorage.getItem('today_vehicle')||'',base_data:this.getBaseData(),delivery_history:this.getDeliveryHistory(),route_cache:this.getCachedRouteData(r),lastLogin:new Date().toISOString()});this.clearSessionCache();['loginStatus','currentRoute','currentUser','currentUserRole','sessionToken'].forEach(k=>localStorage.removeItem(k));window.location.href=window.location.pathname.includes('/pages/')?'../index.html':'index.html';},
  clearSessionCache(){['today_orders','history_view_data','base_data'].forEach(k=>localStorage.removeItem(k));const r=this.getCurrentRoute();if(r)localStorage.removeItem(`route_cache_${r}`);},
  getTodayOrders(){try{const d=localStorage.getItem('today_orders');return d?JSON.parse(d):null;}catch{return null;}},
  getBaseData(){try{const d=localStorage.getItem('base_data');return d?JSON.parse(d):null;}catch{return null;}},
  getDeliveryHistory(){try{const d=localStorage.getItem('delivery_history');return d?JSON.parse(d):null;}catch{return null;}},
  getCachedRouteData(route){try{const d=localStorage.getItem(`route_cache_${this.formatRouteCode(route)}`);return d?JSON.parse(d):null;}catch{return null;}},
  formatRouteCode(input){if(!input)return'';const c=String(input).trim(),m=c.match(/(\d+)号线/);if(m)return String(parseInt(m[1])).padStart(2,'0')+'号线';const n=c.match(/^(\d+)$/);if(n)return String(parseInt(n[1])).padStart(2,'0')+'号线';return c;},
  isValidRouteCode(c){return/^\d{2,}号线$/.test(c);},
  async createRoute(route,password,role='driver',name=''){const f=this.formatRouteCode(route);if(!this.isValidRouteCode(f))return null;if(await this.findUserByRoute(f))return null;const u=await this.createUser(f,password,role,name);if(!u)return null;const stores=[{code:'01',name:'新门店_01',nav:''},{code:'02',name:'新门店_02',nav:''},{code:'03',name:'新门店_03',nav:''}];const data={route:f,stores,createdAt:new Date().toISOString()};this.cacheRouteData(f,data);localStorage.setItem('base_data',JSON.stringify(stores));this.saveUserOrderData(f,{today_orders:null,today_vehicle:'',base_data:stores,delivery_history:[],route_cache:data,created_at:new Date().toISOString()});try{await fetch(`/api/routes?route=${encodeURIComponent(f)}`,{method:'PUT',headers:this.getAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({stores})});}catch(e){console.log('线路 API 不可用，保留本地数据');}this.addLog('线路注册',`新线路 ${f} 注册成功`);return data;},
  cacheRouteData(route,data){const f=this.formatRouteCode(route);localStorage.setItem(`route_cache_${f}`,JSON.stringify(data));const u=this.getUserOrderData(f);if(u){u.route_cache=data;this.saveUserOrderData(f,u);}},
  addLog(action,detail){try{const logs=JSON.parse(localStorage.getItem('admin_logs')||'[]');logs.unshift({id:Date.now(),time:new Date().toLocaleString(),action,detail,user:this.getCurrentRoute()||'system'});if(logs.length>100)logs.length=100;localStorage.setItem('admin_logs',JSON.stringify(logs));}catch(e){console.warn('日志记录失败:',e);}}
};
document.addEventListener('DOMContentLoaded',()=>{const p=window.location.pathname.split('/').pop();if(!['index.html','login.html',''].includes(p))Auth.checkAuth();});
window.Auth=Auth;
