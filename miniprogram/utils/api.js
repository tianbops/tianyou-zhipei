const app = getApp();

function request(path, options = {}) {
  const token = app.globalData.token || wx.getStorageSync('zhipei_token') || '';
  const header = { 'content-type': 'application/json', ...(options.header || {}) };
  if (token) header.Authorization = `Bearer ${token}`;

  return new Promise((resolve, reject) => {
    wx.request({
      url: `${app.globalData.apiBase}${path}`,
      method: options.method || 'GET',
      data: options.data,
      header,
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(res.data);
        reject(new Error(res.data?.message || `请求失败：${res.statusCode}`));
      },
      fail: reject
    });
  });
}

module.exports = { request };
