// 天友智配One - 前端认证
// 服务器 Session 是唯一身份来源；浏览器不保存密码、Session Token 或线路身份。
// 注意：本文件必须保持零语法错误，否则整个 window.Auth 都不会注册。
window.Auth = {
  serverUser: null,
  authPromise: null,

  async loginWithCredentials(_type, account, password) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
        body: JSON.stringify({ username: String(account || '').trim(), password: String(password || '') })
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw Object.assign(new Error('登录请求超时，请稍后重试'), { status: 408 });
      throw Object.assign(new Error('登录请求失败：' + (error?.message || '网络异常')), { status: 0 });
    } finally {
      clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      const error = new Error(data?.error || `登录失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.detail = data?.detail || '';
      throw error;
    }
    this.serverUser = data.user || null;
    this.clearDispatchRoute();
    return this.serverUser;
  },

  async register(payload) {
    let response;
    let data = {};
    try {
      response = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
        body: JSON.stringify(payload || {})
      });
      data = await response.json().catch(() => ({}));
    } catch (networkError) {
      const error = new Error(`注册请求失败：${networkError?.message || '网络异常'}`);
      error.status = 0;
      throw error;
    }
    if (!response.ok || !data?.success) {
      const detail = String(data?.detail || '').trim();
      const message = detail ? `${data?.error || '注册失败'}：${detail}` : (data?.error || `注册失败（HTTP ${response.status}）`);
      const error = new Error(message);
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    this.serverUser = data.user || null;
    this.clearDispatchRoute();
    return this.serverUser;
  },

  async getProfile() {
    const response = await fetch('/api/profile', { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      const error = new Error(data?.error || `资料读取失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    this.serverUser = data.user || null;
    return this.serverUser;
  },

  async updateProfile(payload) {
    const response = await fetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify(payload || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      const error = new Error(data?.error || `资料保存失败（HTTP ${response.status}）`);
      error.status = response.status;
      throw error;
    }
    this.serverUser = data.user || null;
    return this.serverUser;
  },

  async getCurrentServerUser() {
    if (this.serverUser) return this.serverUser;
    const response = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) {
      this.serverUser = null;
      return null;
    }
    const data = await response.json().catch(() => null);
    this.serverUser = data?.success ? data.user : null;
    return this.serverUser;
  },

  async checkAuth() {
    const page = location.pathname.split('/').pop() || 'index.html';
    if (['index.html', 'login.html'].includes(page)) {
      const user = await this.getCurrentServerUser().catch(() => null);
      if (user) {
        const target = user.adminLevel === 'primary' ? 'admin.html' : 'home.html';
        if (location.pathname.endsWith('/index.html') || location.pathname.endsWith('/')) location.replace(target);
      }
      return !user;
    }
    if (this.authPromise) return this.authPromise;
    this.authPromise = this.getCurrentServerUser().then(user => {
      if (!user) {
        location.replace(location.pathname.includes('/pages/') ? '../index.html' : 'index.html');
        return false;
      }
      if (user.adminLevel === 'primary' && page !== 'admin.html') {
        location.replace(location.pathname.includes('/pages/') ? '../admin.html' : 'admin.html');
        return false;
      }
      return true;
    }).catch(() => {
      location.replace(location.pathname.includes('/pages/') ? '../index.html' : 'index.html');
      return false;
    }).finally(() => {
      this.authPromise = null;
    });
    return this.authPromise;
  },

  getCurrentRoute() { return this.getDispatchRoute(); },
  getBoundRoute() { return this.serverUser?.boundRouteId || ''; },
  getDispatchRoute() {
    const selected = String(sessionStorage.getItem('zhipei_dispatch_route_v1') || '').trim();
    return selected || this.getBoundRoute();
  },
  setDispatchRoute(route) {
    const value = this.formatRouteCode(route);
    if (value) sessionStorage.setItem('zhipei_dispatch_route_v1', value);
    else sessionStorage.removeItem('zhipei_dispatch_route_v1');
    return value;
  },
  clearDispatchRoute() { sessionStorage.removeItem('zhipei_dispatch_route_v1'); },
  getRoute() { return this.getDispatchRoute(); },

  async logout() {
    this.clearDispatchRoute();
    this.serverUser = null;
    this.authPromise = null;
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
    location.replace(location.pathname.includes('/pages/') ? '../index.html' : 'index.html');
  },

  formatRouteCode(input) {
    const value = String(input || '').trim();
    const match = value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
    return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : value;
  },

  isValidRouteCode(value) {
    return /^\d+$/.test(String(value || '').trim()) || /^\d+号线$/.test(String(value || '').trim());
  }
};

/*
 * 全站统一身份守卫：
 * - 业务页面必须是业务用户
 * - admin.html 必须是唯一主系统管理员
 * - 直接 URL、浏览器前进/后退、BFCache 恢复都重新以服务器 Session 为准
 * - 不依赖页面自身是否主动调用 checkAuth()
 */
(function setupGlobalAuthGuard() {
  const guard = () => window.Auth?.checkAuth?.();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', guard, { once: true });
  } else {
    guard();
  }
  window.addEventListener('pageshow', guard);
})();

// 全站统一返回。这里使用简单的 URL 解析，不使用容易造成语法错误的复杂正则。
(function setupSmartBack() {
  function isAppPage(url) {
    try {
      const target = new URL(url, location.href);
      if (target.origin !== location.origin) return false;
      const path = target.pathname.replace(/\\/g, '/');
      const file = path.split('/').pop() || '';
      return file !== 'index.html';
    } catch (_) {
      return false;
    }
  }

  function fallbackHome() {
    return location.pathname.includes('/pages/') ? '../home.html' : 'home.html';
  }

  // 浏览器/手机系统的侧滑返回无法由网页可靠取消，因此核心策略是：认证页永不留在业务历史栈。
  // 页面内返回仍优先遵循真实业务历史；没有合法业务来源时回到首页。
  document.addEventListener('click', event => {
    const button = event.target.closest?.('.back-btn');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const referrer = document.referrer;
    if (referrer && isAppPage(referrer) && window.history.length > 1) {
      window.history.back();
      return;
    }
    window.location.replace(fallbackHome());
  }, true);
})();
