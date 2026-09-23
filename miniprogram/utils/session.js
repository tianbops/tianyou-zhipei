const app = getApp();

function saveSession(token, user) {
  app.globalData.token = String(token || '');
  app.globalData.user = user || null;
  // 新会话不能继承上一账号的调度线路，避免账号切换后串线。
  const boundRoute = String(user?.boundRouteId || '').trim();
  app.globalData.dispatchRoute = boundRoute;
  wx.removeStorageSync('zhipei_dispatch_route');
  if (boundRoute) wx.setStorageSync('zhipei_dispatch_route', boundRoute);
  if (token) wx.setStorageSync('zhipei_token', token);
  if (user) wx.setStorageSync('zhipei_user', user);
}

function clearSession() {
  app.globalData.token = '';
  app.globalData.user = null;
  app.globalData.dispatchRoute = '';
  wx.removeStorageSync('zhipei_token');
  wx.removeStorageSync('zhipei_user');
  wx.removeStorageSync('zhipei_dispatch_route');
}

function isLoggedIn() {
  return Boolean(app.globalData.token || wx.getStorageSync('zhipei_token'));
}

module.exports = { saveSession, clearSession, isLoggedIn };
