// 天友智配One - 前端认证
// 服务器 Session 是唯一身份来源；浏览器不保存密码、Session Token 或线路身份。
// 注意：本文件必须保持零语法错误，否则整个 window.Auth 都不会注册。
window.Auth = {
  serverUser: null,
  authPromise: null,

  async loginWithCredentials(_type, account, password) {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({ username: String(account || '').trim(), password: String(password || '') })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      const error = new Error(data?.error || `登录失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.detail = data?.detail || '';
      throw error;
    }
    this.serverUser = data.user || null;
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
    const page = location.pathname.split('/').pop();
    if (['index.html', 'login.html', ''].includes(page)) return true;
    if (this.serverUser && (this.serverUser.route || page === 'settings.html')) return true;
    if (this.authPromise) return this.authPromise;
    this.authPromise = this.getCurrentServerUser().then(user => {
      if (!user) {
        location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
        return false;
      }
      if (!user.route && page !== 'settings.html') {
        location.href = location.pathname.includes('/pages/') ? '../settings.html' : 'settings.html';
        return false;
      }
      return true;
    }).catch(() => {
      location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
      return false;
    }).finally(() => {
      this.authPromise = null;
    });
    return this.authPromise;
  },

  getCurrentRoute() { return this.serverUser?.route || ''; },
  getRoute() { return this.serverUser?.route || ''; },
  getCurrentUser() { return this.serverUser?.name || this.serverUser?.username || ''; },
  getUser() { return this.serverUser || null; },

  async logout() {
    this.serverUser = null;
    this.authPromise = null;
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
    location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
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

window.Authentication = window.Auth;

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
    window.location.href = fallbackHome();
  }, true);
})();
