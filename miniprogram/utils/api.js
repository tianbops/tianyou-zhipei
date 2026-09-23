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
        const detail = res.data?.message || res.data?.error || `请求失败：${res.statusCode}`;
        const error = new Error(detail);
        error.statusCode = res.statusCode;
        error.code = res.data?.code || res.data?.errorCode || '';
        reject(error);
      },
      fail: reject
    });
  });
}

module.exports = { request };
