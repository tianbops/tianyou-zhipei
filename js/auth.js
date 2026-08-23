// js/auth.js
// ============================================================
// 统一数据层：所有用户数据读写通过 Auth 统一管理
// ============================================================

const Auth = {
  // ============================================================
  // 唯一的用户数据获取入口
  // ============================================================
  async getUsers() {
    // 1. 优先从 Upstash 获取
    try {
      const remote = await this.fetchUsersFromUpstash();
      if (remote && remote.length > 0) {
        // 同步到本地缓存
        localStorage.setItem('admin_users', JSON.stringify(remote));
        return remote;
      }
    } catch (e) {
      console.warn('从 Upstash 获取用户数据失败，使用本地缓存');
    }
    // 2. 回退到 localStorage
    return this.getLocalUsers();
  },

  // ============================================================
  // 唯一的用户数据保存入口
  // ============================================================
  async saveUsers(users) {
    // 1. 保存到 Upstash
    try {
      await this.saveUsersToUpstash(users);
    } catch (e) {
      console.warn('Upstash 保存失败，仅保存到本地');
    }
    // 2. 同步到 localStorage（缓存）
    localStorage.setItem('admin_users', JSON.stringify(users));
  },

  // ============================================================
  // 本地缓存操作（内部使用）
  // ============================================================
  getLocalUsers() {
    try {
      const data = localStorage.getItem('admin_users');
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  // ============================================================
  // Upstash 交互（内部使用）
  // ============================================================
  async fetchUsersFromUpstash() {
    const response = await fetch('/api/users');
    if (!response.ok) throw new Error('Failed to fetch users');
    const data = await response.json();
    // 兼容字符串与对象
    let users = data.users;
    if (typeof users === 'string') {
      users = JSON.parse(users);
    }
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

  // ============================================================
  // 业务方法（调用统一入口）
  // ============================================================
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
    const user = await this.findUserByRoute(route);
    return user !== null;
  },

  // 创建用户
  async createUser(route, password, role = 'driver', name = '') {
    const formattedRoute = this.formatRouteCode(route);
    const existing = await this.findUserByRoute(formattedRoute);
    if (existing) return null;

    const users = await this.getUsers();
    const maxId = users.reduce((max, u) => Math.max(max, u.id || 0), 0);
    const newUser = {
      id: maxId + 1,
      name: name || '',
      route: formattedRoute,
      password: password,
      role: role,
      createdAt: new Date().toISOString()
    };
    users.push(newUser);
    await this.saveUsers(users);
    this.addLog('用户注册', `新用户注册: ${formattedRoute} (${role})`);
    return newUser;
  },

  // 更新用户
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

  // 删除用户
  async deleteUser(route) {
    const formattedRoute = this.formatRouteCode(route);
    let users = await this.getUsers();
    users = users.filter(u => u.route !== formattedRoute);
    await this.saveUsers(users);
    this.addLog('用户删除', `删除用户: ${formattedRoute}`);
  },

  // ============================================================
  // 运单数据（与用户无关，保持原有逻辑）
  // ============================================================
  getUserDataKey(route) {
    const formatted = this.formatRouteCode(route);
    return `user_data_${formatted}`;
  },

  getUserOrderData(route) {
    try {
      const key = this.getUserDataKey(route);
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  saveUserOrderData(route, data) {
    const key = this.getUserDataKey(route);
    localStorage.setItem(key, JSON.stringify(data));
  },

  clearUserOrderData(route) {
    const key = this.getUserDataKey(route);
    localStorage.removeItem(key);
  },

  // ============================================================
  // 登录状态管理
  // ============================================================
  checkAuth() {
    const loginStatus = localStorage.getItem('loginStatus');
    const currentRoute = localStorage.getItem('currentRoute');
    if (loginStatus === 'true' && currentRoute) return true;
    const currentPage = window.location.pathname.split('/').pop();
    const loginPages = ['index.html', 'login.html', ''];
    if (loginPages.includes(currentPage)) return false;
    window.location.href = window.location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
    return false;
  },

  getCurrentRoute() {
    return localStorage.getItem('currentRoute') || '';
  },

  getCurrentUser() {
    return localStorage.getItem('currentUser') || '司机';
  },

  login(route, user = '司机') {
    this.clearSessionCache();
    const formattedRoute = this.formatRouteCode(route);
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
      const userData = {
        today_orders: this.getTodayOrders(),
        today_vehicle: localStorage.getItem('today_vehicle') || '',
        base_data: this.getBaseData(),
        delivery_history: this.getDeliveryHistory(),
        route_cache: this.getCachedRouteData(route),
        lastLogin: new Date().toISOString()
      };
      this.saveUserOrderData(route, userData);
    }
    this.clearSessionCache();
    localStorage.removeItem('loginStatus');
    localStorage.removeItem('currentRoute');
    localStorage.removeItem('currentUser');
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

  // ============================================================
  // 辅助方法
  // ============================================================
  getTodayOrders() {
    try { const data = localStorage.getItem('today_orders'); return data ? JSON.parse(data) : null; } catch { return null; }
  },

  getBaseData() {
    try { const data = localStorage.getItem('base_data'); return data ? JSON.parse(data) : null; } catch { return null; }
  },

  getDeliveryHistory() {
    try { const data = localStorage.getItem('delivery_history'); return data ? JSON.parse(data) : null; } catch { return null; }
  },

  getCachedRouteData(route) {
    const formatted = this.formatRouteCode(route);
    const data = localStorage.getItem(`route_cache_${formatted}`);
    return data ? JSON.parse(data) : null;
  },

  formatRouteCode(input) {
    if (!input) return '';
    let code = input.trim();
    if (code.includes('号线')) {
      const numMatch = code.match(/(\d+)号线/);
      if (numMatch) {
        const num = parseInt(numMatch[1]);
        return String(num).padStart(2, '0') + '号线';
      }
    }
    const numMatch = code.match(/^(\d+)$/);
    if (numMatch) {
      const num = parseInt(numMatch[1]);
      return String(num).padStart(2, '0') + '号线';
    }
    return code;
  },

  isValidRouteCode(code) {
    return /^\d{2,}号线$/.test(code);
  },

  // ============================================================
  // 创建新线路（注册时调用）
  // ============================================================
  async createRoute(route, password, role = 'driver', name = '') {
    const formattedRoute = this.formatRouteCode(route);
    if (!this.isValidRouteCode(formattedRoute)) return null;

    const existing = await this.findUserByRoute(formattedRoute);
    if (existing) return null;

    const newUser = await this.createUser(formattedRoute, password, role, name);
    if (!newUser) return null;

    // 初始化默认门店数据（可从黄金数据源加载，这里简化）
    const defaultStores = [
      { code: "01", name: "新门店_01", nav: "" },
      { code: "02", name: "新门店_02", nav: "" },
      { code: "03", name: "新门店_03", nav: "" }
    ];
    
    const newRouteData = {
      route: formattedRoute,
      stores: defaultStores,
      createdAt: new Date().toISOString()
    };

    this.cacheRouteData(formattedRoute, newRouteData);
    localStorage.setItem('base_data', JSON.stringify(defaultStores));
    
    const emptyUserData = {
      today_orders: null,
      today_vehicle: '',
      base_data: defaultStores,
      delivery_history: [],
      route_cache: newRouteData,
      created_at: new Date().toISOString()
    };
    this.saveUserOrderData(formattedRoute, emptyUserData);
    
    // 同步线路数据到 Upstash
    try {
      await fetch(`/api/routes/${encodeURIComponent(formattedRoute)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stores: defaultStores })
      });
    } catch (e) { console.log('API不可用，数据已保存在本地'); }
    
    this.addLog('线路注册', `新线路 ${formattedRoute} 注册成功`);
    return newRouteData;
  },

  cacheRouteData(route, data) {
    const formatted = this.formatRouteCode(route);
    localStorage.setItem(`route_cache_${formatted}`, JSON.stringify(data));
    const userData = this.getUserOrderData(formatted);
    if (userData) {
      userData.route_cache = data;
      this.saveUserOrderData(formatted, userData);
    }
  },

  // ============================================================
  // 日志（保留）
  // ============================================================
  addLog(action, detail) {
    try {
      const logs = JSON.parse(localStorage.getItem('admin_logs') || '[]');
      logs.unshift({
        id: Date.now(),
        time: new Date().toLocaleString(),
        action,
        detail,
        user: this.getCurrentRoute() || 'system'
      });
      if (logs.length > 100) logs.length = 100;
      localStorage.setItem('admin_logs', JSON.stringify(logs));
    } catch (e) {
      console.warn('日志记录失败:', e);
    }
  }
};

// ============================================================
// 页面加载自动检查登录状态
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  const currentPage = window.location.pathname.split('/').pop();
  const loginPages = ['index.html', 'login.html', ''];
  if (!loginPages.includes(currentPage)) Auth.checkAuth();
});