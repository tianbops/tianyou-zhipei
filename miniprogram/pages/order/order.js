const { request } = require('../../utils/api');
const app = getApp();
Page({
  data: { user: {}, dispatchRoute: '', vehicle: '', stores: [] },
  onShow() { this.load(); },
  async load() {
    const user = app.globalData.user || wx.getStorageSync('zhipei_user') || {};
    let route = String(app.globalData.dispatchRoute || wx.getStorageSync('zhipei_dispatch_route') || '').trim();
    // 未绑定用户也可以直接使用已有线路；若首次进入子页面还没有 dispatchRoute，补充读取启用线路。
    if (!route) {
      try {
        const routeData = await request('/api/routes');
        const routes = (Array.isArray(routeData?.routes) ? routeData.routes : []).filter(x => x?.status !== 'disabled');
        route = String(routes[0]?.id || '').trim();
        if (route) {
          app.globalData.dispatchRoute = route;
          wx.setStorageSync('zhipei_dispatch_route', route);
        }
      } catch (e) { /* 保持空线路，后续统一按登录/线路错误处理 */ }
    }
    this.setData({ user, dispatchRoute: route });
    try {
      const date = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const data = await request('/api/v3/today?route='+encodeURIComponent(route)+'&date='+encodeURIComponent(date));
      const order = data?.today || data?.order || data || {};
      const stores = Array.isArray(order.orders) ? order.orders : (Array.isArray(order.stores) ? order.stores : []);
      this.setData({ stores, vehicle: String(order.vehicle || '') });
    } catch (e) { if (/401|403|登录/.test(String(e.message))) wx.reLaunch({ url: '/pages/login/login' }); }
  }
});