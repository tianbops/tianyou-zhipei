// js/auth.js
// 当前测试版本：仅服务17号线，服务器 Session 是唯一身份来源。
// 浏览器不保存密码、Session Token 或线路身份。
const Auth = {
  serverUser: null,
  authPromise: null,

  async loginWithCredentials(type, account, password) {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({ type: 'route', account: '17号线', password })
    });

    let d = null;
    try { d = await r.json(); } catch {}

    if (!r.ok || !d?.success) {
      const e = new Error(d?.error || '登录失败');
      e.status = r.status;
      throw e;
    }

    this.serverUser = d.user || null;
    return this.serverUser;
  },

  getSessionToken() { return ''; },
  getAuthHeaders(extra = {}) { return { ...extra }; },

  async getCurrentServerUser() {
    const r = await fetch('/api/me', { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) {
      this.serverUser = null;
      return null;
    }
    const d = await r.json().catch(() => null);
    this.serverUser = d?.success ? d.user : null;
    return this.serverUser;
  },

  async getUsers() { return this.fetchUsersFromUpstash(); },
  async fetchUsersFromUpstash() {
    const r = await fetch('/api/users', {
      cache: 'no-store',
      headers: this.getAuthHeaders(),
      credentials: 'same-origin'
    });
    if (!r.ok) throw Error('用户数据读取失败');
    const d = await r.json();
    let u = d.users;
    if (typeof u === 'string') u = JSON.parse(u);
    return Array.isArray(u) ? u : [];
  },

  async saveUsersToUpstash(users) {
    const r = await fetch('/api/users', {
      method: 'POST',
      headers: this.getAuthHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ users }),
      cache: 'no-store',
      credentials: 'same-origin'
    });
    if (!r.ok) throw Error('用户数据保存失败');
  },

  async saveUsers(users) { return this.saveUsersToUpstash(users); },

  async findUserByRoute(route) {
    const f = this.formatRouteCode(route);
    if (f !== '17号线') return null;
    const u = await this.getUsers();
    return u.find(x => x.route === f && x.role !== 'admin') || null;
  },

  async isRouteRegistered(route) { return !!(await this.findUserByRoute(route)); },

  getUserDataKey() { return 'server:17号线'; },
  getUserOrderData() { return null; },
  saveUserOrderData() { return false; },
  clearUserOrderData() { return true; },

  async checkAuth() {
    const p = location.pathname.split('/').pop();
    if (['index.html', 'login.html', ''].includes(p)) return true;
    if (this.authPromise) return this.authPromise;

    this.authPromise = this.getCurrentServerUser().then(u => {
      if (!u || u.route !== '17号线') {
        location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
        return false;
      }
      return true;
    }).catch(() => {
      location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
      return false;
    }).finally(() => { this.authPromise = null; });

    return this.authPromise;
  },

  getCurrentRoute() { return '17号线'; },
  getCurrentUser() { return '17号线'; },

  async logout() {
    this.serverUser = null;
    this.authPromise = null;
    await fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store'
    }).catch(() => {});
    location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
  },

  clearSessionCache() {
    [
      'today_orders', 'history_view_data', 'base_data', 'delivery_history',
      'today_vehicle', 'today_total_weight', 'today_order_date',
      'today_order_source', 'sessionToken', 'loginStatus', 'currentRoute', 'currentUser'
    ].forEach(k => localStorage.removeItem(k));
  },

  getTodayOrders() { return null; },
  getBaseData() { return null; },
  getDeliveryHistory() { return null; },
  getCachedRouteData() { return null; },

  formatRouteCode(input) {
    if (!input) return '';
    const c = String(input).trim();
    const m = c.match(/(\d+)号线/);
    if (m) return String(parseInt(m[1], 10)).padStart(2, '0') + '号线';
    const n = c.match(/^(\d+)$/);
    if (n) return String(parseInt(n[1], 10)).padStart(2, '0') + '号线';
    return c;
  },

  isValidRouteCode(c) { return c === '17号线'; },
  cacheRouteData() { return false; },
  addLog(action, detail) { console.info('日志由服务器管理：', action, detail); }
};

document.addEventListener('DOMContentLoaded', () => {
  const p = location.pathname.split('/').pop();
  if (!['index.html', 'login.html', ''].includes(p)) Auth.checkAuth();
});

window.Auth = Auth;
