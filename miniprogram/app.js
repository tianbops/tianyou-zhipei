App({
  globalData: {
    apiBase: '',
    user: null,
    token: ''
  },

  onLaunch() {
    const token = wx.getStorageSync('zhipei_token') || '';
    const user = wx.getStorageSync('zhipei_user') || null;
    this.globalData.token = token;
    this.globalData.user = user;
  }
});
