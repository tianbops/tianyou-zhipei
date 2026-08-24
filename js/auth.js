// js/auth.js
// ============================================================
// 统一数据层：所有用户数据读写通过 Auth 统一管理
// ============================================================

const Auth = {
  async loginWithCredentials(type, account, password) {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ type, account, password })
    });

    let data = null;
    try { data = await response.json(); } catch { data = null; }

    if (!response.ok || !data?.success) {
      const error = new Error(data?.error || '账号或密码错误');
      error.status = response.status;
      throw error;
    }

    const user = data.user;
    const route = type === 'admin' ? 'admin' : this.formatRouteCode(user.route);
    this.login(route, user.name || (type === 'admin' ? '管理员' : '司机'));
    localStorage.setItem('currentUserRole', user.role || (type === 'admin' ? 'admin' : 'driver'));
    return user;
  },

  async getUsers() {
    try {
      const remote = await this.fetchUsersFromUpstash();
      if (remote && remote.length > 0) {
        localStorage.setItem('admin_users', JSON.stringify(remote));
        return remote;
      }
    } catch (e) {
      console.warn('从 Upstash 获取用户数据失败，使用本地缓存');
    }
    return this.getLocalUsers();
  },

  getLocalUsers() {
    try {
      const data = localStorage.getItem('admin_users');
      return data ? JSON.parse(data) : [];
    } catch { return []; }
  },

  async fetchUsersFromUpstash() {
    const response = await fetch('/api/users', { cache: 'no-store' });
    if (!response.ok) throw new Error('Failed to fetch users');
    const data = await response.json();
    let users = data.users;
    if (typeof users === 'string') users = JSON.parse(users);
    return Array.isArray(users) ? users : [];
  },

  async saveUsersToUpstash(users) {
    const response = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ users })
    });
    if (!response.ok) throw new Error('Failed to save users');
  },

  async findUserByRoute(route) {
    const users = await this.getUsers();
    const formattedRoute = this.formatRouteCode(route);
    return users.find(u => u.route === formattedRoute) || null;
  },

  async findAdminByName(name) {
    const users = await this.getUsers();
    return users.find(u => u.role === 'admin' && u.name === name) || null;
  },

  async isRouteRegistered(route) {
    return (await this.findUserByRoute(route)) !== null;
  },

  async createUser(route, password, role = 'driver', name = '') {
    const formattedRoute = this.formatRouteCode(route);
    const existing = await this.findUserByRoute(formattedRoute);
    if (existing) return null;
    const users = await this.getUsers();
    const maxId = users.reduce((max, u) => Math.max(max, u.id || 0), 0);
    const newUser = { id: maxId + 1, name: name || '', route: formattedRoute, password, role, createdAt: new Date().toISOString() };
    users.push(newUser);
    await this.saveUsers(users);
    this.addLog('用户注册', `新用户注册: ${formattedRoute} (${role})`);
    return newUser;
  },

  async updateUser(route, updates) {
    const formattedRoute = this.formatRouteCode(route);
    const users = await this.getUsers();
    const idx = users.findIndex(u => u.route === formattedRoute);
    if (idx === -1) return null;
    users[idx] = { ...users[idx], ...updates };
    await this.saveUsers(users);
    this.addLog('用户更新', `更新用户: ${formattedRoute}`);
    return users[idx];
  },

  async deleteUser(route) {
    const formattedRoute = this.formatRouteCode(route);
    let users = await this.getUsers();
    users = users.filter(u => u.route !== formattedRoute);
    await this.saveUsers(users);
    this.addLog('用户删除', `删除用户: ${formattedRoute}`);
  },

  getUserDataKey(route) { return `user_data_${this.formatRouteCode(route)}`; },

  getUserOrderData(route) {
    try {
      const data = localStorage.getItem(this.getUserDataKey(route));
      return data ? JSON.parse(data) : null;
    } catch { return null; }
  },

  saveUserOrderData(route, data) { localStorage.setItem(this.getUserDataKey(route), JSON.stringify(data)); },
  clearUserOrderData(route) { localStorage.removeItem(this.getUserDataKey(route)); },

  checkAuth() {
    const loginStatus = localStorage.getItem('loginStatus');
    const currentRoute = localStorage.getItem('currentRoute');
    if (loginStatus === 'true' && currentRoute) return true;
    const currentPage = window.location.pathname.split('/').pop();
    if (['index.html', 'login.html', ''].includes(currentPage)) return false;
    window.location.href = window.location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
    return false;
  },

  getCurrentRoute() { return localStorage.getItem('currentRoute') || ''; },
  getCurrentUser() { return localStorage.getItem('currentUser') || '司机'; },

  login(route, user = '司机') {
    this.clearSessionCache();
    const formattedRoute = route === 'admin' ? 'admin' : this.formatRouteCode(route);
    localStorage.setItem('loginStatus', 'true');
    localStorage.setItem('currentRoute', formattedRoute);
    localStorage.setItem('currentUser', user);
    const userData = this.getUserOrderData(formattedRoute);
    if (userData) {
      if (userData.today_orders) localStorage.setItem('today_orders', JSON.stringify(userData.today_orders));
      if (userData.today_vehicle) localStorage.setItem('today_vehicle', userData.today_vehicle);
      if (userData.base_data) localStorage.setItem('base_data', JSON.stringify(userData.base_data));
      if (userData.delivery_history) localStorage.setItem('delivery_history', JSON.stringify(userData.delivery_history));
      if (userData.route_cache) localStorage.setItem(`route_cache_${formattedRoute}`, JSON.stringify(userData.route_cache));
    }
  },

  logout() {
    const route = this.getCurrentRoute();
    if (route) {
      this.saveUserOrderData(route, {
        today_orders: this.getTodayOrders(),
        today_vehicle: localStorage.getItem('today_vehicle') || '',
        base_data: this.getBaseData(),
        delivery_history: this.getDeliveryHistory(),
        route_cache: this.getCachedRouteData(route),
        lastLogin: new Date().toISOString()
      });
    }
    this.clearSessionCache();
    localStorage.removeItem('loginStatus');
    localStorage.removeItem('currentRoute');
    localStorage.removeItem('currentUser');
    localStorage.removeItem('currentUserRole');
    window.location.href = window.location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
  },

  clearSessionCache() {
    localStorage.removeItem('today_orders');
    localStorage.removeItem('today_vehicle');
    localStorage.removeItem('history_view_data');
    localStorage.removeItem('base_data');
    const route = this.getCurrentRoute();
    if (route) localStorage.removeItem(`route_cache_${route}`);
  },

  getTodayOrders() { try { const d = localStorage.getItem('today_orders'); return d ? JSON.parse(d) : null; } catch { return null; } },
  getBaseData() { try { const d = localStorage.getItem('base_data'); return d ? JSON.parse(d) : null; } catch { return null; } },
  getDeliveryHistory() { try { const d = localStorage.getItem('delivery_history'); return d ? JSON.parse(d) : null; } catch { return null; } },
  getCachedRouteData(route) { const d = localStorage.getItem(`route_cache_${this.formatRouteCode(route)}`); return d ? JSON.parse(d) : null; },

  formatRouteCode(input) {
    if (!input) return '';
    const code = input.trim();
    const m = code.match(/(\d+)号线/);
    if (m) return String(parseInt(m[1])).padStart(2, '0') + '号线';
    const n = code.match(/^(\d+)$/);
    if (n) return String(parseInt(n[1])).padStart(2, '0') + '号线';
    return code;
  },

  isValidRouteCode(code) { return /^\d{2,}号线$/.test(code); },

  async createRoute(route, password, role = 'driver', name = '') {
    const formattedRoute = this.formatRouteCode(route);
    if (!this.isValidRouteCode(formattedRoute)) return null;
    const existing = await this.findUserByRoute(formattedRoute);
    if (existing) return null;
    const newUser = await this.createUser(formattedRoute, password, role, name);
    if (!newUser) return null;
    const defaultStores = [
      { code: '01', name: '新门店_01', nav: '' },
      { code: '02', name: '新门店_02', nav: '' },
      { code: '03', name: '新门店_03', nav: '' }
    ];
    const newRouteData = { route: formattedRoute, stores: defaultStores, createdAt: new Date().toISOString() };
    this.cacheRouteData(formattedRoute, newRouteData);
    localStorage.setItem('base_data', JSON.stringify(defaultStores));
    this.saveUserOrderData(formattedRoute, { today_orders: null, today_vehicle: '', base_data: defaultStores, delivery_history: [], route_cache: newRouteData, created_at: new Date().toISOString() });
    try {
      await fetch(`/api/routes?route=${encodeURIComponent(formattedRoute)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stores: defaultStores }) });
    } catch (e) { console.log('API不可用，数据已保存在本地'); }
    this.addLog('线路注册', `新线路 ${formattedRoute} 注册成功`);
    return newRouteData;
  },

  cacheRouteData(route, data) {
    const formatted = this.formatRouteCode(route);
    localStorage.setItem(`route_cache_${formatted}`, JSON.stringify(data));
    const userData = this.getUserOrderData(formatted);
    if (userData) { userData.route_cache = data; this.saveUserOrderData(formatted, userData); }
  },

  addLog(action, detail) {
    try {
      const logs = JSON.parse(localStorage.getItem('admin_logs') || '[]');
      logs.unshift({ id: Date.now(), time: new Date().toLocaleString(), action, detail, user: this.getCurrentRoute() || 'system' });
      if (logs.length > 100) logs.length = 100;
      localStorage.setItem('admin_logs', JSON.stringify(logs));
    } catch (e) { console.warn('日志记录失败:', e); }
  }
};

document.addEventListener('DOMContentLoaded', function() {
  const currentPage = window.location.pathname.split('/').pop();
  if (!['index.html', 'login.html', ''].includes(currentPage)) Auth.checkAuth();
});

window.Auth = Auth;
console.log('✅ auth.js 已加载，Auth 对象已暴露');