// js/auth.js
// 认证中心：服务器 Session 是唯一身份来源。
// 浏览器不保存密码、Session Token、当前用户或当前线路。
const Auth={
  serverUser:null,
  authPromise:null,
  async loginWithCredentials(type,account,password){
    const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',credentials:'same-origin',body:JSON.stringify({type,account,password})});
    let d=null;try{d=await r.json()}catch{}
    if(!r.ok||!d?.success){const e=new Error(d?.error||'账号或密码错误');e.status=r.status;throw e}
    this.serverUser=d.user||null;
    return this.serverUser;
  },
  getSessionToken(){return ''},
  getAuthHeaders(extra={}){return {...extra}},
  async getCurrentServerUser(){
    const r=await fetch('/api/me',{cache:'no-store',credentials:'same-origin'});
    if(!r.ok){this.serverUser=null;return null}
    const d=await r.json().catch(()=>null);
    this.serverUser=d?.success?d.user:null;
    return this.serverUser;
  },
  async getUsers(){return this.fetchUsersFromUpstash()},
  async fetchUsersFromUpstash(){const r=await fetch('/api/users',{cache:'no-store',headers:this.getAuthHeaders(),credentials:'same-origin'});if(!r.ok)throw Error(r.status===401?'管理员登录已失效':'用户数据读取失败');const d=await r.json();let u=d.users;if(typeof u==='string')u=JSON.parse(u);return Array.isArray(u)?u:[]},
  async saveUsersToUpstash(users){const r=await fetch('/api/users',{method:'POST',headers:this.getAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({users}),cache:'no-store',credentials:'same-origin'});if(!r.ok)throw Error(r.status===401?'管理员登录已失效':'用户数据保存失败')},
  async saveUsers(users){return this.saveUsersToUpstash(users)},
  async findUserByRoute(route){const u=await this.getUsers(),f=this.formatRouteCode(route);return u.find(x=>x.route===f)||null},
  async findAdminByName(name){const u=await this.getUsers();return u.find(x=>x.role==='admin'&&x.name===name)||null},
  async isRouteRegistered(route){return!!(await this.findUserByRoute(route))},
  async createUser(route,password,role='driver',name=''){const f=this.formatRouteCode(route);if(await this.findUserByRoute(f))return null;const u=await this.getUsers(),id=u.reduce((m,x)=>Math.max(m,x.id||0),0)+1,n={id,name:name||'',route:f,password,role,createdAt:new Date().toISOString(),sessionVersion:1};u.push(n);await this.saveUsersToUpstash(u);return n},
  async updateUser(route,updates){const f=this.formatRouteCode(route),u=await this.getUsers(),i=u.findIndex(x=>x.route===f);if(i<0)return null;u[i]={...u[i],...updates};if(Object.prototype.hasOwnProperty.call(updates,'password'))u[i].sessionVersion=Number(u[i].sessionVersion||1)+1;await this.saveUsersToUpstash(u);return u[i]},
  async deleteUser(route){const f=this.formatRouteCode(route),u=(await this.getUsers()).filter(x=>x.route!==f);await this.saveUsersToUpstash(u)},
  getUserDataKey(route){return `server:${this.formatRouteCode(route)}`},
  getUserOrderData(){return null},saveUserOrderData(){return false},clearUserOrderData(){return true},
  async checkAuth(){
    const p=location.pathname.split('/').pop();
    if(['index.html','login.html',''].includes(p))return true;
    if(this.authPromise)return this.authPromise;
    this.authPromise=this.getCurrentServerUser().then(u=>{
      if(!u){location.href=location.pathname.includes('/pages/')?'../index.html':'index.html';return false}
      return true;
    }).catch(()=>{location.href=location.pathname.includes('/pages/')?'../index.html':'index.html';return false}).finally(()=>{this.authPromise=null});
    return this.authPromise;
  },
  getCurrentRoute(){return this.serverUser?(this.serverUser.role==='admin'?'admin':this.formatRouteCode(this.serverUser.route)):''},
  getCurrentUser(){return this.serverUser?.name||'司机'},
  login(route,user='司机'){const f=route==='admin'?'admin':this.formatRouteCode(route);this.serverUser={...(this.serverUser||{}),route:f,name:user,role:route==='admin'?'admin':'driver'}},
  async logout(){this.serverUser=null;this.authPromise=null;await fetch('/api/logout',{method:'POST',credentials:'same-origin',cache:'no-store'}).catch(()=>{});location.href=location.pathname.includes('/pages/')?'../index.html':'index.html'},
  clearSessionCache(){['today_orders','history_view_data','base_data','delivery_history','today_vehicle','today_total_weight','today_order_date','today_order_source','sessionToken','loginStatus','currentRoute','currentUser'].forEach(k=>localStorage.removeItem(k))},
  getTodayOrders(){return null},getBaseData(){return null},getDeliveryHistory(){return null},getCachedRouteData(){return null},
  formatRouteCode(input){if(!input)return'';const c=String(input).trim(),m=c.match(/(\d+)号线/);if(m)return String(parseInt(m[1])).padStart(2,'0')+'号线';const n=c.match(/^(\d+)$/);if(n)return String(parseInt(n[1])).padStart(2,'0')+'号线';return c},
  isValidRouteCode(c){return/^\d{2,}号线$/.test(c)},
  async createRoute(route,password,role='driver',name=''){const f=this.formatRouteCode(route);if(!this.isValidRouteCode(f)||await this.findUserByRoute(f))return null;const u=await this.createUser(f,password,role,name);if(!u)return null;const stores=[{code:'01',name:'新门店_01',nav:''},{code:'02',name:'新门店_02',nav:''},{code:'03',name:'新门店_03',nav:''}];const r=await fetch(`/api/routes?route=${encodeURIComponent(f)}`,{method:'PUT',headers:this.getAuthHeaders({'Content-Type':'application/json'}),body:JSON.stringify({stores}),credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error('线路基准数据创建失败');return{route:f,stores,createdAt:new Date().toISOString()}},
  cacheRouteData(){return false},
  addLog(action,detail){console.info('日志由服务器管理：',action,detail)}
};
window.openUserManagement=window.openUserManagement||function(){};
document.addEventListener('DOMContentLoaded',()=>{const p=location.pathname.split('/').pop();if(!['index.html','login.html',''].includes(p))Auth.checkAuth()});
window.Auth=Auth;
