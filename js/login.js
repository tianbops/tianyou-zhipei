// js/login.js
// 天友智配 One - 登录页业务逻辑
// 保持 index.html 页面布局不变，认证统一调用 Auth 数据层。

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  function showError(id, message) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    el.style.display = 'block';
  }

  function hide(id) {
    const el = $(id);
    if (el) el.style.display = 'none';
  }

  function showInfo(id, message, color) {
    const el = $(id);
    if (!el) return;
    el.textContent = message;
    if (color) el.style.color = color;
    el.style.display = 'block';
  }

  function routeCode(input) {
    return Auth.formatRouteCode(input);
  }

  function validRoute(input) {
    return Auth.isValidRouteCode(input);
  }

  // ------------------------------------------------------------
  // 普通用户登录
  // ------------------------------------------------------------
  window.login = async function login() {
    const rawRoute = ($('routeCode')?.value || '').trim();
    const password = ($('password')?.value || '').trim();
    hide('loginError');

    if (!rawRoute) return showError('loginError', '⚠️ 请输入线路编号');
    if (!password) return showError('loginError', '⚠️ 请输入密码');

    const formatted = routeCode(rawRoute);
    if (!validRoute(formatted)) {
      return showError('loginError', '⚠️ 线路格式错误，请输入如 17 或 105');
    }

    try {
      const user = await Auth.findUserByRoute(formatted);
      if (!user) {
        return showError('loginError', '❌ 线路未注册，请点击「注册」创建');
      }

      if (String(password) !== String(user.password || '')) {
        return showError('loginError', '❌ 密码错误，请重试');
      }

      Auth.login(formatted, user.name || formatted, user.role || 'driver');
      Auth.addLog('用户登录', `${formatted} 登录系统`);
      window.location.href = 'home.html';
    } catch (error) {
      console.error('登录错误:', error);
      showError('loginError', '⚠️ 网络错误，请稍后重试');
    }
  };

  window.togglePassword = function togglePassword() {
    const input = $('password');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  };

  // ------------------------------------------------------------
  // 注册
  // ------------------------------------------------------------
  window.openRegister = function openRegister() {
    $('registerOverlay')?.classList.add('active');
    if ($('registerRoute')) $('registerRoute').value = '';
    if ($('registerPassword')) $('registerPassword').value = '';
    hide('registerError');
    hide('registerInfo');
  };

  window.closeRegister = function closeRegister() {
    $('registerOverlay')?.classList.remove('active');
  };

  window.toggleRegisterPassword = function toggleRegisterPassword() {
    const input = $('registerPassword');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  };

  async function getEnterprisePassword() {
    // 当前后端用户接口已存在时，允许管理员设置的统一密码继续兼容旧版本。
    // 后续接入独立配置 API 时，仅需替换这一处，不影响页面。
    return localStorage.getItem('unified_password') || 'tianyou2024';
  }

  window.doRegister = async function doRegister() {
    const rawRoute = ($('registerRoute')?.value || '').trim();
    const password = ($('registerPassword')?.value || '').trim();
    hide('registerError');
    hide('registerInfo');

    if (!rawRoute) return showError('registerError', '⚠️ 请输入线路编号');
    if (!password) return showError('registerError', '⚠️ 请输入企业统一密码');

    const formatted = routeCode(rawRoute);
    if (!validRoute(formatted)) {
      return showError('registerError', '⚠️ 线路格式错误，请输入如 17 或 105');
    }

    try {
      const enterprisePassword = await getEnterprisePassword();
      if (password !== enterprisePassword) {
        return showError('registerError', '❌ 企业统一密码错误，请重试');
      }

      if (await Auth.isRouteRegistered(formatted)) {
        return showError('registerError', '❌ 该线路已被注册，请直接登录');
      }

      showInfo('registerInfo', '⏳ 正在创建新线路...', '#FFB020');
      const routeData = await Auth.createRoute(formatted, enterprisePassword, 'driver', formatted);

      if (!routeData) {
        hide('registerInfo');
        return showError('registerError', '❌ 线路创建失败，请重试');
      }

      showInfo('registerInfo', '✅ 线路注册成功！正在跳转...', '#27AE60');
      Auth.login(formatted, formatted, 'driver');
      Auth.addLog('线路注册', `${formatted} 注册成功`);

      setTimeout(() => {
        window.location.href = 'home.html';
      }, 800);
    } catch (error) {
      console.error('注册错误:', error);
      hide('registerInfo');
      showError('registerError', '⚠️ 网络异常，请稍后重试');
    }
  };

  // ------------------------------------------------------------
  // 管理员登录
  // ------------------------------------------------------------
  window.openAdminLogin = function openAdminLogin() {
    $('adminLoginOverlay')?.classList.add('active');
    if ($('adminRoute')) $('adminRoute').value = '';
    if ($('adminPassword')) $('adminPassword').value = '';
    hide('adminLoginError');
  };

  window.closeAdminLogin = function closeAdminLogin() {
    $('adminLoginOverlay')?.classList.remove('active');
  };

  window.toggleAdminPassword = function toggleAdminPassword() {
    const input = $('adminPassword');
    if (input) input.type = input.type === 'password' ? 'text' : 'password';
  };

  window.adminLogin = async function adminLogin() {
    const name = ($('adminRoute')?.value || '').trim();
    const password = ($('adminPassword')?.value || '').trim();
    hide('adminLoginError');

    if (!name) return showError('adminLoginError', '⚠️ 请输入用户名');
    if (!password) return showError('adminLoginError', '⚠️ 请输入密码');

    try {
      const admin = await Auth.findAdminByName(name);
      if (!admin) return showError('adminLoginError', '❌ 管理员不存在');

      if (String(password) !== String(admin.password || '')) {
        return showError('adminLoginError', '❌ 密码错误，请重试');
      }

      Auth.login(name, admin.name || '管理员', 'admin');
      Auth.addLog('管理员登录', `${name} 登录管理系统`);
      closeAdminLogin();
      window.location.href = 'admin.html';
    } catch (error) {
      console.error('管理员登录错误:', error);
      showError('adminLoginError', '⚠️ 网络错误，请稍后重试');
    }
  };

  // ------------------------------------------------------------
  // 输入、弹窗、自动跳转
  // ------------------------------------------------------------
  function normalizeInput(id) {
    const input = $(id);
    if (!input) return;
    const value = input.value.trim();
    if (!value) return;
    const formatted = routeCode(value);
    if (validRoute(formatted)) input.value = formatted;
  }

  document.addEventListener('DOMContentLoaded', function () {
    $('registerOverlay')?.addEventListener('click', function (e) {
      if (e.target === this) closeRegister();
    });

    $('adminLoginOverlay')?.addEventListener('click', function (e) {
      if (e.target === this) closeAdminLogin();
    });

    $('routeCode')?.addEventListener('blur', () => normalizeInput('routeCode'));
    $('registerRoute')?.addEventListener('blur', () => normalizeInput('registerRoute'));

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if ($('adminLoginOverlay')?.classList.contains('active')) return adminLogin();
      if ($('registerOverlay')?.classList.contains('active')) return doRegister();
      login();
    });

    if (localStorage.getItem('loginStatus') === 'true') {
      const role = localStorage.getItem('currentUserRole');
      window.location.href = role === 'admin' ? 'admin.html' : 'home.html';
    }
  });
})();
