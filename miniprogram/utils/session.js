const app = getApp();

function saveSession(token, user) {
  app.globalData.token = String(token || '');
  app.globalData.user = user || null;
  if (token) wx.setStorageSync('zhipei_token', token);
  if (user) wx.setStorageSync('zhipei_user', user);
}

function clearSession() {
  app.globalData.token = '';
  app.globalData.user = null;
  wx.removeStorageSync('zhipei_token');
  wx.removeStorageSync('zhipei_user');
}

function isLoggedIn() {
  return Boolean(app.globalData.token || wx.getStorageSync('zhipei_token'));
}

module.exports = { saveSession, clearSession, isLoggedIn };
