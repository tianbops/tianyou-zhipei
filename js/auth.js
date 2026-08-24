// js/auth.js
// ============================================================
// 天友智配 One - 统一认证与线路数据层
// 页面布局保持不变；业务数据统一优先使用 API，localStorage 仅作会话缓存。
// ============================================================

const Auth = {
  api: {
    users: '/api/users',
    route: '/api/routes'
  },

  formatRouteCode(input) {
    if (input === null || input === undefined) return '';
    const code = String(input).trim();
    if (!code) return '';

    const match = code.match(/^(\d+)\s*号线$/) || code.match(/^(\d+)$/);
    if (match) return `${String(parseInt(match[1], 10)).padStart(2, '0')}号线`;
    return code;
  },

  isValidRouteCode(code) {
    return /^\d+号线$/.test(this.formatRouteCode(code));
  },

  getCurrentRoute() {
    return this.formatRouteCode(localStorage.getItem('currentRoute') || '');
  },

  getCurrentUser() {
    return localStorage.getItem('currentUser') || '司机';
  },

  getCurrentUserRole() {
    return localStorage.getItem('currentUserRole') || 'driver';
  },

  // ------------------------------------------------------------
  // 用户数据
  // ------------------------------------------------------------
  async fetchUsersFromUpstash() {
    const response = await fetch(this.api.users, { cache: 'no-store' });
    if (!response.ok) throw new Error(`用户 API ${response.status}`);
    const data = await response.json();
    let users = data?.users;
    if (typeof users === 'string') users = JSON.parse(users);
    return Array.isArray(users) ? users : [];
  },

  getLocalUsers() {
    try {
      const data = localStorage.getItem('admin_users');
      const users = data ? JSON.parse(data) : [];
      return Array.isArray(users) ? users : [];
    } catch {
      return [];
    }
  },

  async getUsers() {
    try {
      const users = await this.fetchUsersFromUpstash();
      localStorage.setItem('admin_users', JSON.stringify(users));
      return users;
    } catch (error) {
      console.warn('用户 API 不可用，使用本地缓存:', error);
      return this.getLocalUsers();
    }
  },

  async saveUsersToUpstash(users) {
    const response = await fetch(this.api.users, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ users })
    });
    if (!response.ok) throw new Error(`用户保存失败 ${response.status}`);
    localStorage.setItem('admin_users', JSON.stringify(users));
    return true;
  },

  async saveUsers(users) {
    try {
      await this.saveUsersToUpstash(users);
      return true;
    } catch (error) {
      console.error('用户同步失败:', error);
      localStorage.setItem('admin_users', JSON.stringify(users));
      return false;
    }
  },

  async findUserByRoute(route) {
    const formatted = this.formatRouteCode(route);
    const users = await this.getUsers();
    return users.find(user => this.formatRouteCode(user.route) === formatted) || null;
  },

  async findAdminByName(name) {
    const users = await this.getUsers();
    return users.find(user => user.role === 'admin' && user.name === name) || null;
  },

  async isRouteRegistered(route) {
    return !!(await this.findUserByRoute(route));
  },

  async createUser(route, password, role = 'driver', name = '') {
    const formatted = this.formatRouteCode(route);
    if (!formatted || await this.isRouteRegistered(formatted)) return null;

    const users = await this.getUsers();
    const maxId = users.reduce((max, user) => Math.max(max, Number(user.id) || 0), 0);
    const newUser = {
      id: maxId + 1,
      name: name || formatted,
      route: formatted,
      password: String(password || ''),
      role,
      createdAt: new Date().toISOString()
    };

    users.push(newUser);
    await this.saveUsers(users);
    this.addLog('用户注册', `新用户注册：${formatted} (${role})`);
    return newUser;
  },

  async updateUser(route, updates = {}) {
    const formatted = this.formatRouteCode(route);
    const users = await this.getUsers();
    const index = users.findIndex(user => this.formatRouteCode(user.route) === formatted);
    if (index < 0) return null;

    users[index] = { ...users[index], ...updates, route: formatted };
    await this.saveUsers(users);
    this.addLog('用户更新', `更新用户：${formatted}`);
    return users[index];
  },

  async deleteUser(route) {
    const formatted = this.formatRouteCode(route);
    const users = await this.getUsers();
    const next = users.filter(user => this.formatRouteCode(user.route) !== formatted);
    if (next.length === users.length) return false;
    await this.saveUsers(next);
    this.addLog('用户删除', `删除用户：${formatted}`);
    return true;
  },

  // ------------------------------------------------------------
  // 线路数据：唯一业务数据源为 /api/routes
  // ------------------------------------------------------------
  async fetchRouteData(route) {
    const formatted = this.formatRouteCode(route);
    if (!formatted) return null;

    const url = `${this.api.route}?route=${encodeURIComponent(formatted)}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`线路 API ${response.status}`);

    const data = await response.json();
    const routeData = {
      route: formatted,
      stores: Array.isArray(data?.stores) ? data.stores : []
    };

    this.cacheRouteData(formatted, routeData);
    return routeData;
  },

  async getRouteData(route, options = {}) {
    const formatted = this.formatRouteCode(route);
    if (!formatted) return null;

    try {
      return await this.fetchRouteData(formatted);
    } catch (error) {
      if (options.allowCache === false) throw error;
      console.warn('线路 API 不可用，使用缓存:', error);
      return this.getCachedRouteData(formatted);
    }
  },

  async saveRouteData(route, stores) {
    const formatted = this.formatRouteCode(route);
    if (!formatted) throw new Error('线路编号不能为空');
    if (!Array.isArray(stores)) throw new Error('门店数据格式错误');

    const response = await fetch(`${this.api.route}?route=${encodeURIComponent(formatted)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stores })
    });

    if (!response.ok) throw new Error(`线路保存失败 ${response.status}`);

    const data = { route: formatted, stores };
    this.cacheRouteData(formatted, data);
    localStorage.setItem('base_data', JSON.stringify(stores));
    this.addLog('线路更新', `更新线路：${formatted}，${stores.length} 家门店`);
    return data;
  },

  getCachedRouteData(route) {
    try {
      const formatted = this.formatRouteCode(route);
      const raw = localStorage.getItem(`route_cache_${formatted}`);
      if (!raw) return null;
      const data = JSON.parse(raw);
      return data && Array.isArray(data.stores) ? data : null;
    } catch {
      return null;
    }
  },

  cacheRouteData(route, data) {
    const formatted = this.formatRouteCode(route);
    if (!formatted || !data) return;
    const normalized = { route: formatted, stores: Array.isArray(data.stores) ? data.stores : [] };
    localStorage.setItem(`route_cache_${formatted}`, JSON.stringify(normalized));
    localStorage.setItem('base_data', JSON.stringify(normalized.stores));
  },

  async getBaseData(route = this.getCurrentRoute()) {
    const data = await this.getRouteData(route);
    return data?.stores || [];
  },

  // ------------------------------------------------------------
  // 兼容旧页面的数据方法
  // ------------------------------------------------------------
  getUserDataKey(route) {
    return `user_data_${this.formatRouteCode(route)}`;
  },

  getUserOrderData(route) {
    try {
      const raw = localStorage.getItem(this.getUserDataKey(route));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  saveUserOrderData(route, data) {
    localStorage.setItem(this.getUserDataKey(route), JSON.stringify(data || {}));
  },

  clearUserOrderData(route) {
    localStorage.removeItem(this.getUserDataKey(route));
  },

  getTodayOrders() {
    try {
      const raw = localStorage.getItem('today_orders');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  saveTodayOrders(orders) {
    localStorage.setItem('today_orders', JSON.stringify(Array.isArray(orders) ? orders : []));
  },

  getDeliveryHistory() {
    try {
      const raw = localStorage.getItem('delivery_history');
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  },

  saveDeliveryHistory(history) {
    localStorage.setItem('delivery_history', JSON.stringify(Array.isArray(history) ? history : []));
  },

  // ------------------------------------------------------------
  // 登录/退出
  // ------------------------------------------------------------
  checkAuth() {
    const loginStatus = localStorage.getItem('loginStatus');
    const currentRoute = this.getCurrentRoute();
    if (loginStatus === 'true' && currentRoute) return true;

    const currentPage = window.location.pathname.split('/').pop();
    if (['index.html', 'login.html', ''].includes(currentPage)) return false;

    window.location.href = window.location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
    return false;
  },

  login(route, user = '司机', role = 'driver') {
    this.clearSessionCache();
    const formatted = this.formatRouteCode(route);
    localStorage.setItem('loginStatus', 'true');
    localStorage.setItem('currentRoute', formatted);
    localStorage.setItem('currentUser', user);
    localStorage.setItem('currentUserRole', role);
  },

  logout() {
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

  // ------------------------------------------------------------
  // 创建线路
  // ------------------------------------------------------------
  async createRoute(route, password, role = 'driver', name = '') {
    const formatted = this.formatRouteCode(route);
    if (!this.isValidRouteCode(formatted)) return null;
    if (await this.isRouteRegistered(formatted)) return null;

    const user = await this.createUser(formatted, password, role, name || formatted);
    if (!user) return null;

    const stores = [];
    const routeData = await this.saveRouteData(formatted, stores);
    this.addLog('线路注册', `新线路注册成功：${formatted}`);
    return routeData;
  },

  // ------------------------------------------------------------
  // 本地日志
  // ------------------------------------------------------------
  addLog(action, detail) {
    try {
      const logs = JSON.parse(localStorage.getItem('admin_logs') || '[]');
      logs.unshift({
        id: Date.now(),
        time: new Date().toLocaleString('zh-CN'),
        action,
        detail,
        user: this.getCurrentRoute() || 'system'
      });
      if (logs.length > 100) logs.length = 100;
      localStorage.setItem('admin_logs', JSON.stringify(logs));
    } catch (error) {
      console.warn('日志记录失败:', error);
    }
  }
};

window.Auth = Auth;

document.addEventListener('DOMContentLoaded', () => {
  const currentPage = window.location.pathname.split('/').pop();
  const loginPages = ['index.html', 'login.html', ''];
  if (!loginPages.includes(currentPage)) Auth.checkAuth();
});

console.log('天友智配 One Auth 数据层已加载');