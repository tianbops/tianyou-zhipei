const app = getApp();
const { clearSession } = require('../../utils/session');
Page({
 data:{user:{}},
 onShow(){this.setData({user:app.globalData.user||wx.getStorageSync('zhipei_user')||{}})},
 changePassword(){wx.showToast({title:'请在网页端修改密码',icon:'none'})},
 logout(){clearSession();wx.reLaunch({url:'/pages/login/login'})}
});
