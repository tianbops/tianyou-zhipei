const { request } = require('../../utils/api');
const app = getApp();
Page({
  data: { user: {}, dispatchRoute: '', vehicle: '', stores: [] },
  onShow() { this.load(); },
  async load() {
    const user = app.globalData.user || wx.getStorageSync('zhipei_user') || {};
    const route = String(app.globalData.dispatchRoute || wx.getStorageSync('zhipei_dispatch_route') || user.boundRouteId || '').trim();
    this.setData({ user, dispatchRoute: route });
    try {
      const data = await request(route ? `/api/orders?route=${encodeURIComponent(route)}` : '/api/orders');
      const order = data?.today || data?.order || data || {};
      const stores = Array.isArray(order.orders) ? order.orders : (Array.isArray(order.stores) ? order.stores : []);
      this.setData({ stores, vehicle: String(order.vehicle || '') });
    } catch (e) { if (/401|403|登录/.test(String(e.message))) wx.reLaunch({ url: '/pages/login/login' }); }
  }
});