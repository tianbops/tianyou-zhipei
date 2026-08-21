const Auth = {
  // ============================================================
  // 统一用户数据管理 - 所有用户信息存储在 admin_users
  // ============================================================
  
  // 获取所有用户
  getUsers() {
    try {
      const data = localStorage.getItem('admin_users');
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  },

  // 保存所有用户
  saveUsers(users) {
    localStorage.setItem('admin_users', JSON.stringify(users));
  },

  // 根据线路查找用户
  findUserByRoute(route) {
    const users = this.getUsers();
    const formattedRoute = this.formatRouteCode(route);
    return users.find(u => u.route === formattedRoute) || null;
  },

  // 检查线路是否已被注册
  isRouteRegistered(route) {
    return this.findUserByRoute(route) !== null;
  },

  // 创建新用户（注册时调用）
  createUser(route, role = 'driver', name = '') {
    const users = this.getUsers();
    const formattedRoute = this.formatRouteCode(route);
    
    if (users.some(u => u.route === formattedRoute)) {
      return null;
    }
    
    const maxId = users.reduce((max, u) => Math.max(max, u.id || 0), 0);
    const newUser = {
      id: maxId + 1,
      name: name || '',
      route: formattedRoute,
      password: 'tianyou2024',
      role: role,
      createdAt: new Date().toISOString()
    };
    
    users.push(newUser);
    this.saveUsers(users);
    this.addLog('用户注册', `新用户注册: ${formattedRoute} (${role})`);
    
    return newUser;
  },

  // 更新用户信息（管理中心编辑时调用）
  updateUser(route, updates) {
    const users = this.getUsers();
    const formattedRoute = this.formatRouteCode(route);
    const idx = users.findIndex(u => u.route === formattedRoute);
    if (idx === -1) return null;
    
    users[idx] = { ...users[idx], ...updates };
    this.saveUsers(users);
    this.addLog('用户更新', `更新用户: ${formattedRoute}`);
    
    return users[idx];
  },

  // 删除用户
  deleteUser(route) {
    let users = this.getUsers();
    const formattedRoute = this.formatRouteCode(route);
    users = users.filter(u => u.route !== formattedRoute);
    this.saveUsers(users);
    this.addLog('用户删除', `删除用户: ${formattedRoute}`);
  },

  // ============================================================
  // 用户运单数据隔离 - 每个用户独立存储
  // ============================================================
  
  getUserDataKey(route) {
    const formatted = this.formatRouteCode(route);
    return `user_data_${formatted}`;
  },

  // 获取用户运单数据
  getUserOrderData(route) {
    try {
      const key = this.getUserDataKey(route);
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : null;
    } catch {
      return null;
    }
  },

  // 保存用户运单数据
  saveUserOrderData(route, data) {
    const key = this.getUserDataKey(route);
    localStorage.setItem(key, JSON.stringify(data));
  },

  // 清除用户运单数据
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
    if (loginStatus !== 'true' || !currentRoute) {
      const path = window.location.pathname;
      if (path.includes('/pages/')) {
        window.location.href = '../index.html';
      } else {
        window.location.href = 'index.html';
      }
      return false;
    }
    return true;
  },

  getCurrentRoute() {
    return localStorage.getItem('currentRoute') || '';
  },

  getCurrentUser() {
    return localStorage.getItem('currentUser') || '司机';
  },

  // ============================================================
  // 登录 - 加载用户数据
  // ============================================================
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

  // ============================================================
  // 退出登录 - 保存用户数据并清除缓存
  // ============================================================
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

  // ============================================================
  // 清除会话缓存
  // ============================================================
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

  // ============================================================
  // 数据获取辅助方法
  // ============================================================
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

  // ============================================================
  // 格式化线路编号（确保两位数）
  // ============================================================
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
  // 验证线路是否存在（用户已注册）
  // ============================================================
  async validateRoute(route) {
    const formattedRoute = this.formatRouteCode(route);
    if (!this.isValidRouteCode(formattedRoute)) {
      return null;
    }

    const user = this.findUserByRoute(formattedRoute);
    if (user) {
      const userData = this.getUserOrderData(formattedRoute);
      if (userData && userData.route_cache) {
        return userData.route_cache;
      }
      const defaultStores = [
        { code: "01", name: "新门店_01", nav: "" },
        { code: "02", name: "新门店_02", nav: "" },
        { code: "03", name: "新门店_03", nav: "" }
      ];
      return { route: formattedRoute, stores: defaultStores };
    }

    const cached = this.getCachedRouteData(formattedRoute);
    if (cached) {
      return cached;
    }

    try {
      const baseData = localStorage.getItem('base_data');
      if (baseData) {
        const stores = JSON.parse(baseData);
        if (stores && stores.length > 0) {
          const routeData = { route: formattedRoute, stores: stores };
          this.cacheRouteData(formattedRoute, routeData);
          return routeData;
        }
      }
    } catch (e) {
      console.warn('读取本地数据失败:', e);
    }

    try {
      const response = await fetch(`/api/route/${encodeURIComponent(formattedRoute)}`);
      if (response.ok) {
        const data = await response.json();
        if (data && data.stores) {
          this.cacheRouteData(formattedRoute, data);
          return data;
        }
      }
    } catch (e) {
      console.log('API不可用，使用本地数据');
    }

    return null;
  },

  // ============================================================
  // 创建新线路（注册时调用）- 同时创建用户
  // ============================================================
  async createRoute(route, role = 'driver', name = '') {
    const formattedRoute = this.formatRouteCode(route);
    if (!this.isValidRouteCode(formattedRoute)) {
      return null;
    }

    const existingUser = this.findUserByRoute(formattedRoute);
    if (existingUser) {
      return null;
    }

    const newUser = this.createUser(formattedRoute, role, name);
    if (!newUser) {
      return null;
    }

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

  // ============================================================
  // 缓存线路数据
  // ============================================================
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
  // 添加日志
  // ============================================================
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

// 页面加载时自动检查登录状态
document.addEventListener('DOMContentLoaded', function() {
  const currentPage = window.location.pathname.split('/').pop();
  const loginPages = ['index.html', 'login.html'];
  if (!loginPages.includes(currentPage) && !currentPage.includes('.')) {
    Auth.checkAuth();
  }
});
