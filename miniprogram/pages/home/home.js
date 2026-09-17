const { request } = require('../../utils/api');
const app = getApp();

Page({
  data: { user: {}, order: { count: 0, weight: '0kg', stores: [] } },

  onShow() { this.loadToday(); },

  async loadToday() {
    const user = app.globalData.user || wx.getStorageSync('zhipei_user') || {};
    this.setData({ user });
    try {
      const data = await request('/api/orders');
      const order = data?.order || data || {};
      const stores = Array.isArray(order.stores) ? order.stores : (Array.isArray(order.orders) ? order.orders : []);
      const weight = order.totalWeight ?? order.weight ?? '0kg';
      this.setData({ order: { count: Number(order.storeCount ?? order.count ?? stores.length), weight: String(weight), stores } });
    } catch (e) {
      if (/401|403|未登录|登录/.test(String(e.message))) wx.reLaunch({ url: '/pages/login/login' });
    }
  },

  openOrder() { wx.navigateTo({ url: '/pages/order/order' }); },
  openHistory() { wx.navigateTo({ url: '/pages/history/history' }); },
  openSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); }
});
