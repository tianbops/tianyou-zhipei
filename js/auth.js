// 天友智配One - 前端认证
// 服务器 Session 是唯一身份来源；浏览器不保存密码、Session Token 或线路身份。
const Auth = {
  serverUser: null,
  authPromise: null,

  async loginWithCredentials(_type, account, password) {
    const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', credentials: 'same-origin', body: JSON.stringify({ username: String(account || '').trim(), password }) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) { const error = new Error(data?.error || '登录失败'); error.status = response.status; throw error; }
    this.serverUser = data.user || null;
    return this.serverUser;
  },

  async register(payload) {
    const response = await fetch('/api/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', credentials: 'same-origin', body: JSON.stringify(payload || {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) { const error = new Error(data?.error || '注册失败'); error.status = response.status; throw error; }
    this.serverUser = data.user || null;
    return data.user || null;
  },

  async getProfile() {
    const response = await fetch('/api/profile', { cache: 'no-store', credentials: 'same-origin' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) { const error = new Error(data?.error || '资料读取失败'); error.status = response.status; throw error; }
    this.serverUser = data.user || null;
    return this.serverUser;
  },

  async updateProfile(payload) {
    const response = await fetch('/api/profile', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', credentials: 'same-origin', body: JSON.stringify(payload || {}) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) { const error = new Error(data?.error || '资料保存失败'); error.status = response.status; throw error; }
    this.serverUser = data.user || null;
    return this.serverUser;
  },

  async getCurrentServerUser() {
    if (this.serverUser) return this.serverUser;
    const response = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) { this.serverUser = null; return null; }
    const data = await response.json().catch(() => null);
    this.serverUser = data?.success ? data.user : null;
    return this.serverUser;
  },

  async checkAuth() {
    const page = location.pathname.split('/').pop();
    if (['index.html', 'login.html', ''].includes(page)) return true;
    if (this.serverUser) {
      if (this.serverUser.route || page === 'settings.html') return true;
    }
    if (this.authPromise) return this.authPromise;
    this.authPromise = this.getCurrentServerUser().then(user => {
      if (!user) { location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html'; return false; }
      if (!user.route && page !== 'settings.html') { location.href = location.pathname.includes('/pages/') ? '../settings.html' : 'settings.html'; return false; }
      return true;
    }).catch(() => { location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html'; return false; }).finally(() => { this.authPromise = null; });
    return this.authPromise;
  },

  getCurrentRoute() { return this.serverUser?.route || ''; },
  getCurrentUser() { return this.serverUser?.name || this.serverUser?.username || ''; },

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
  isValidRouteCode(value) { return /^\d+$/.test(String(value || '').trim()) || /^\d+号线$/.test(String(value || '').trim()); }
};
window.Auth = Auth;
