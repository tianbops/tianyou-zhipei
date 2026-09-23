const { request } = require('../../utils/api');
const app = getApp();

Page({
  data: { user: {}, order: { count: 0, weight: '0.00t', stores: [] } },
  onShow() { this.loadToday(); },
  async loadToday() {
    const user = app.globalData.user || wx.getStorageSync('zhipei_user') || {};
    this.setData({ user });
    try {
      const data = await request('/api/orders');
      // Web / 小程序统一读取服务器真实的 today 结构；不再依赖旧的 order 字段。
      const order = data?.today || data?.order || data || {};
      const stores = Array.isArray(order.orders) ? order.orders : (Array.isArray(order.stores) ? order.stores : []);
      const rawWeight = order.totalWeight ?? order.weight ?? '0kg';
      const source = String(rawWeight).trim().replace(/,/g, '');
      const match = source.match(/[0-9]+(?:\.[0-9]+)?/);
      const value = match ? Number(match[0]) : NaN;
      const tons = Number.isFinite(value) ? (/kg|千克|公斤/i.test(source) ? value / 1000 : /吨|\bt\b/i.test(source) ? value : value >= 1000 ? value / 1000 : value) : NaN;
      const weight = Number.isFinite(tons) ? ((Math.round((tons + Number.EPSILON) * 100) / 100).toFixed(2) + 't') : '0.00t';
      this.setData({ order: { count: Number(order.uniqueStoreCount ?? order.count ?? stores.length), weight, stores } });
    } catch (e) {
      if (/401|403|未登录|登录/.test(String(e.message))) wx.reLaunch({ url: '/pages/login/login' });
    }
  },
  openOrder() { wx.navigateTo({ url: '/pages/order/order' }); },
  openHistory() { wx.navigateTo({ url: '/pages/history/history' }); },
  openSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); }
});
