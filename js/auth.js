const Auth = {
  // ============================================================
  // 从 Upstash 获取用户数据（实时）
  // ============================================================
  async fetchUsersFromUpstash() {
    try {
      const response = await fetch('/api/users');
      if (response.ok) {
        const data = await response.json();
        if (data.users && data.users.length > 0) {
          // 同步到 localStorage 作为缓存
          localStorage.setItem('admin_users', JSON.stringify(data.users));
          return data.users;
        }
      }
    } catch (e) {
      console.log('从 Upstash 获取用户数据失败');
    }
    // 如果 Upstash 没有数据，返回 localStorage 中的缓存
    return this.getLocalUsers();
  },

  // ============================================================
  // 获取本地缓存用户数据（备用）
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
  // 保存用户数据到 Upstash（实时同步）
  // ============================================================
  async saveUsersToUpstash(users) {
    try {
      const response = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: users })
      });
      if (response.ok) {
        console.log('用户数据已同步到 Upstash');
        // 同步到 localStorage 作为缓存
        localStorage.setItem('admin_users', JSON.stringify(users));
        return true;
      }
    } catch (e) {
      console.log('Upstash 同步失败');
    }
    // 同步失败时保存到 localStorage
    localStorage.setItem('admin_users', JSON.stringify(users));
    return false;
  },

  // ============================================================
  // 获取统一密码（从 localStorage 读取）
  // ============================================================
  getUnifiedPassword() {
    return localStorage.getItem('unified_password') || 'tianyou2024';
  },

  // ============================================================
  // 根据线路查找用户（实时从 Upstash 获取）
  // ============================================================
  async findUserByRoute(route) {
    const users = await this.fetchUsersFromUpstash();
    const formattedRoute = this.formatRouteCode(route);
    return users.find(u => u.route === formattedRoute) || null;
  },

  // ============================================================
  // 根据用户名查找管理员（实时从 Upstash 获取）
  // ============================================================
  async findAdminByName(name) {
    const users = await this.fetchUsersFromUpstash();
    return users.find(u => u.role === 'admin' && u.name === name) || null;
  },

  // ============================================================
  // 检查线路是否已被注册
  // ============================================================
  async isRouteRegistered(route) {
    const user = await this.findUserByRoute(route);
    return user !== null;
  },

  // ============================================================
  // 创建新用户（注册时调用）
  // ============================================================
  async createUser(route, password, role = 'driver', name = '') {
    const formattedRoute = this.formatRouteCode(route);
    
    // 检查是否已存在
    const existing = await this.findUserByRoute(formattedRoute);
    if (existing) {
      return null;
    }

    // 获取当前用户列表
    const users = await this.fetchUsersFromUpstash();
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
    await this.saveUsersToUpstash(users);
    this.addLog('用户注册', `新用户注册: ${formattedRoute} (${role})`);
    
    return newUser;
  },

  // ============================================================
  // 更新用户信息
  // ============================================================
  async updateUser(route, updates) {
    const formattedRoute = this.formatRouteCode(route);
    const users = await this.fetchUsersFromUpstash();
    const idx = users.findIndex(u => u.route === formattedRoute);
    if (idx === -1) return null;
    
    users[idx] = { ...users[idx], ...updates };
    await this.saveUsersToUpstash(users);
    this.addLog('用户更新', `更新用户: ${formattedRoute}`);
    
    return users[idx];
  },

  // ============================================================
  // 删除用户
  // ============================================================
  async deleteUser(route) {
    const formattedRoute = this.formatRouteCode(route);
    let users = await this.fetchUsersFromUpstash();
    users = users.filter(u => u.route !== formattedRoute);
    await this.saveUsersToUpstash(users);
    this.addLog('用户删除', `删除用户: ${formattedRoute}`);
  },

  // ============================================================
  // 用户运单数据隔离（localStorage 存储）
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
    
    if (loginStatus === 'true' && currentRoute) {
      return true;
    }
    
    const currentPage = window.location.pathname.split('/').pop();
    const loginPages = ['index.html', 'login.html', ''];
    
    if (loginPages.includes(currentPage)) {
      return false;
    }
    
    if (window.location.pathname.includes('/pages/')) {
      window.location.href = '../index.html';
    } else {
      window.location.href = 'index.html';
    }
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
      if (userData.today_orders) {
        localStorage.setItem('today_orders', JSON.stringify(userData.today_orders));
      }
      if (userData.today_vehicle) {
        localStorage.setItem('today_vehicle', userData.today_vehicle);
      }
      if (userData.base_data) {
        localStorage.setItem('base_data', JSON.stringify(userData.base_data));
      }
      if (userData.delivery_history) {
        localStorage.setItem('delivery_history', JSON.stringify(userData.delivery_history));
      }
      if (userData.route_cache) {
        localStorage.setItem(`route_cache_${formattedRoute}`, JSON.stringify(userData.route_cache));
      }
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
    
    const path = window.location.pathname;
    if (path.includes('/pages/')) {
      window.location.href = '../index.html';
    } else {
      window.location.href = 'index.html';
    }
  },

  clearSessionCache() {
    localStorage.removeItem('today_orders');
    localStorage.removeItem('today_vehicle');
    localStorage.removeItem('history_view_data');
    localStorage.removeItem('base_data');
    const route = this.getCurrentRoute();
    if (route) {
      localStorage.removeItem(`route_cache_${route}`);
    }
  },

  getTodayOrders() {
    try {
      const data = localStorage.getItem('today_orders');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  getBaseData() {
    try {
      const data = localStorage.getItem('base_data');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  getDeliveryHistory() {
    try {
      const data = localStorage.getItem('delivery_history');
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
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
    if (!this.isValidRouteCode(formattedRoute)) {
      return null;
    }

    // 检查是否已注册
    const existing = await this.findUserByRoute(formattedRoute);
    if (existing) {
      return null;
    }

    // 创建用户
    const newUser = await this.createUser(formattedRoute, password, role, name);
    if (!newUser) {
      return null;
    }

    // 初始化默认门店数据
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
      const response = await fetch(`/api/route/${encodeURIComponent(formattedRoute)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stores: defaultStores })
      });
      if (response.ok) {
        this.addLog('线路注册', `新线路 ${formattedRoute} API同步成功`);
      }
    } catch (e) {
      console.log('API不可用，数据已保存在本地');
    }
    
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

  addLog(action, detail) {
    try {
      const logs = JSON.parse(localStorage.getItem('admin_logs') || '[]');
      logs.unshift({
        id: Date.now(),
        time: new Date().toLocaleString(),
        action: action,
        detail: detail,
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
// 页面加载时检查登录状态
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  const currentPage = window.location.pathname.split('/').pop();
  const loginPages = ['index.html', 'login.html', ''];
  
  if (!loginPages.includes(currentPage)) {
    Auth.checkAuth();
  }
});
