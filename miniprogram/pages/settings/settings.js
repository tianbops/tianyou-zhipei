const app = getApp();
Page({
 data:{user:{}},
 onShow(){this.setData({user:app.globalData.user||wx.getStorageSync('zhipei_user')||{}})},
 changePassword(){wx.showToast({title:'请在网页端修改密码',icon:'none'})},
 logout(){wx.removeStorageSync('zhipei_token');wx.removeStorageSync('zhipei_user');app.globalData.token='';app.globalData.user=null;wx.reLaunch({url:'/pages/login/login'})}
});
