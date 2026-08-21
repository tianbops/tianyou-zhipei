// ============================================================
// 登录逻辑
// ============================================================
async function login() {
  const routeCode = document.getElementById('routeCode').value.trim();
  const password = document.getElementById('password').value.trim();
  const errorEl = document.getElementById('loginError');
  errorEl.style.display = 'none';

  if (!routeCode) {
    errorEl.textContent = '⚠️ 请输入线路编号';
    errorEl.style.display = 'block';
    return;
  }
  if (!password) {
    errorEl.textContent = '⚠️ 请输入密码';
    errorEl.style.display = 'block';
    return;
  }

  try {
    const routeData = await Auth.validateRoute(routeCode);
    if (!routeData) {
      errorEl.textContent = '❌ 线路不存在，请检查线路编号';
      errorEl.style.display = 'block';
      return;
    }

    const ADMIN_ROUTES = ['admin', '管理员', 'ADMIN'];
    const ADMIN_PASSWORD = 'admin123';
    const UNIFIED_PASSWORD = 'tianyou2024';

    if (ADMIN_ROUTES.includes(routeCode)) {
      if (password === ADMIN_PASSWORD) {
        Auth.login(routeCode);
        Auth.addLog('管理员登录', `${routeCode} 登录系统`);
        window.location.href = 'admin.html';
      } else {
        errorEl.textContent = '❌ 用户名或密码错误，请重试';
        errorEl.style.display = 'block';
      }
    } else {
      if (password === UNIFIED_PASSWORD) {
        Auth.login(routeCode);
        Auth.cacheRouteData(routeCode, routeData);
        Auth.addLog('用户登录', `${routeCode} 登录系统`);
        window.location.href = 'home.html';
      } else {
        errorEl.textContent = '❌ 账号或密码错误，请重试';
        errorEl.style.display = 'block';
      }
    }
  } catch (error) {
    errorEl.textContent = '⚠️ 网络错误，请稍后重试';
    errorEl.style.display = 'block';
    console.error(error);
  }
}

function togglePassword() {
  const pwd = document.getElementById('password');
  pwd.type = pwd.type === 'password' ? 'text' : 'password';
}

// 回车触发登录
document.addEventListener('keydown', function(e) {
  if (e.key === 'Enter') {
    login();
  }
});

// 如果已登录，跳转到对应页面
if (localStorage.getItem('loginStatus') === 'true') {
  const currentRoute = Auth.getCurrentRoute();
  const adminRoutes = ['admin', '管理员', 'ADMIN'];
  if (adminRoutes.includes(currentRoute)) {
    window.location.href = 'admin.html';
  } else {
    window.location.href = 'home.html';
  }
}
