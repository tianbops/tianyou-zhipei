const { request } = require('../../utils/api');
const { saveSession } = require('../../utils/session');

Page({
  data: { username: '', password: '', loading: false, error: '' },

  onUsername(e) { this.setData({ username: e.detail.value, error: '' }); },
  onPassword(e) { this.setData({ password: e.detail.value, error: '' }); },

  async login() {
    const username = String(this.data.username || '').trim();
    const password = String(this.data.password || '');
    if (!username || !password) return this.setData({ error: '请输入账号和密码' });

    this.setData({ loading: true, error: '' });
    try {
      const data = await request('/api/login', {
        method: 'POST',
        data: { username, password, client: 'miniprogram' }
      });
      const token = String(data?.token || '');
      const user = data?.user || null;
      if (!token || !user) throw new Error('登录返回数据不完整');
      saveSession(token, user);
      wx.reLaunch({ url: '/pages/home/home' });
    } catch (err) {
      this.setData({ error: err?.message || '登录失败，请稍后重试' });
    } finally {
      this.setData({ loading: false });
    }
  }
});
