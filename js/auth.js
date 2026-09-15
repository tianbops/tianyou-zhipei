// 天友智配One - 前端认证
// 服务器 Session 是唯一身份来源；浏览器不保存密码、Session Token 或线路身份。
const Auth = {
  serverUser: null,
  authPromise: null,

  async loginWithCredentials(_type, account, password) {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      credentials: 'same-origin',
      body: JSON.stringify({ type: 'route', username: String(account || '').trim(), password })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      const error = new Error(data?.error || '登录失败');
      error.status = response.status;
      throw error;
    }
    this.serverUser = data.user || null;
    return this.serverUser;
  },

  getSessionToken() { return ''; },
  getAuthHeaders(extra = {}) { return { ...extra }; },

  async getCurrentServerUser() {
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
    if (this.authPromise) return this.authPromise;

    this.authPromise = this.getCurrentServerUser().then(user => {
      if (!user || user.route !== '17号线') {
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
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin', cache: 'no-store' }).catch(() => {});
    location.href = location.pathname.includes('/pages/') ? '../index.html' : 'index.html';
  },

  formatRouteCode(input) {
    const value = String(input || '').trim();
    const match = value.match(/^(?:([0-9]+)|([0-9]+)号线)$/);
    return match ? `${String(parseInt(match[1] || match[2], 10)).padStart(2, '0')}号线` : value;
  },

  isValidRouteCode(value) { return this.formatRouteCode(value) === '17号线'; }
};

document.addEventListener('DOMContentLoaded', () => {
  const page = location.pathname.split('/').pop();
  if (!['index.html', 'login.html', ''].includes(page)) Auth.checkAuth();
});

window.Auth = Auth;
