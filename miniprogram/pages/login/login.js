const { request } = require('../../utils/api');
const { saveSession } = require('../../utils/session');

Page({
  data: { username: '', password: '', loading: false, wxLoading: false, error: '' },

  onUsername(e) { this.setData({ username: e.detail.value, error: '' }); },
  onPassword(e) { this.setData({ password: e.detail.value, error: '' }); },

  async login() {
    const username = String(this.data.username || '').trim();
    const password = String(this.data.password || '');
    if (!username || !password) return this.setData({ error: '请输入账号和密码' });
    await this.createSession({ username, password });
  },

  wechatLogin() {
    if (this.data.loading || this.data.wxLoading) return;
    this.setData({ wxLoading: true, error: '' });
    wx.login({
      success: async ({ code }) => {
        if (!code) throw new Error('微信登录凭证获取失败');
        await this.createSession({
          code,
          username: String(this.data.username || '').trim(),
          password: String(this.data.password || '')
        });
      },
      fail: err => this.setData({ error: err?.errMsg || '微信登录失败' }),
      complete: () => this.setData({ wxLoading: false })
    });
  },

  async createSession(data) {
    this.setData({ loading: true, error: '' });
    try {
      const result = await request('/api/mini-login', { method: 'POST', data });
      const token = String(result?.token || '');
      const user = result?.user || null;
      if (!token || !user) throw new Error(result?.message || '登录返回数据不完整');
      saveSession(token, user);
      wx.reLaunch({ url: '/pages/home/home' });
    } catch (err) {
      this.setData({ error: err?.message || '登录失败，请稍后重试' });
    } finally {
      this.setData({ loading: false });
    }
  }
});
