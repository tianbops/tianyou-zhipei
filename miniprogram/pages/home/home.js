const { request } = require('../../utils/api');
const app = getApp();

Page({
  data: {
    user: {},
    routes: [],
    dispatchRoute: '',
    routeIndex: 0,
    order: { count: 0, weight: '0.00t', stores: [] }
  },

  async onShow() {
    const user = app.globalData.user || wx.getStorageSync('zhipei_user') || {};
    const selected = String(app.globalData.dispatchRoute || wx.getStorageSync('zhipei_dispatch_route') || user.boundRouteId || user.route || '').trim();
    this.setData({ user, dispatchRoute: selected });
    await this.loadRoutes(selected);
    await this.loadToday();
  },

  async loadRoutes(selected) {
    try {
      const data = await request('/api/routes');
      const routes = Array.isArray(data?.routes) ? data.routes : [];
      const exists = routes.some(item => String(item?.id || '').trim() === selected);
      const dispatchRoute = exists ? selected : String(routes[0]?.id || selected || '').trim();
      app.globalData.dispatchRoute = dispatchRoute;
      if (dispatchRoute) wx.setStorageSync('zhipei_dispatch_route', dispatchRoute);
      const routeIndex = Math.max(0, routes.findIndex(item => String(item?.id || '').trim() === dispatchRoute));
      this.setData({ routes, dispatchRoute, routeIndex });
    } catch (e) {
      // 路线列表失败不阻断已保存路线的今日查询。
    }
  },

  onRouteChange(e) {
    const index = Number(e.detail.value);
    const route = String(this.data.routes[index]?.id || '').trim();
    if (!route) return;
    app.globalData.dispatchRoute = route;
    wx.setStorageSync('zhipei_dispatch_route', route);
    const routeIndex = this.data.routes.findIndex(item => String(item?.id || '').trim() === route);
    this.setData({ dispatchRoute: route, routeIndex: Math.max(0, routeIndex), order: { count: 0, weight: '0.00t', stores: [] } });
    this.loadToday();
  },

  async loadToday() {
    const route = String(this.data.dispatchRoute || app.globalData.dispatchRoute || '').trim();
    try {
      const data = await request(route ? `/api/orders?route=${encodeURIComponent(route)}` : '/api/orders');
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