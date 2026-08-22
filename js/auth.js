createUser(route, role = 'driver', name = '') {
  const users = this.getUsers();
  const formattedRoute = this.formatRouteCode(route);
  
  if (users.some(u => u.route === formattedRoute)) {
    return null;
  }
  
  const maxId = users.reduce((max, u) => Math.max(max, u.id || 0), 0);
  
  // ===== 从 localStorage 读取统一密码，如果没有则使用默认值 =====
  const unifiedPassword = localStorage.getItem('unified_password') || 'tianyou2024';
  
  const newUser = {
    id: maxId + 1,
    name: name || '',
    route: formattedRoute,
    password: unifiedPassword,
    role: role,
    createdAt: new Date().toISOString()
  };
  
  users.push(newUser);
  this.saveUsers(users);
  this.addLog('用户注册', `新用户注册: ${formattedRoute} (${role})`);
  
  return newUser;
}
