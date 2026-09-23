App({
  globalData: {
    apiBase: '',
    user: null,
    token: '',
    dispatchRoute: ''
  },

  onLaunch() {
    const token = wx.getStorageSync('zhipei_token') || '';
    const user = wx.getStorageSync('zhipei_user') || null;
    const savedRoute = wx.getStorageSync('zhipei_dispatch_route') || '';
    this.globalData.token = token;
    this.globalData.user = user;
    this.globalData.dispatchRoute = savedRoute || String(user?.boundRouteId || '').trim();
  }
});