// js/admin/user_manage.js
// 用户管理模块

let currentUserEditId = null;

// ============================================================
// 打开用户管理
// ============================================================
function openUserManagement() {
  openDialog('userDialog');
  renderUsers();
}

// ============================================================
// 渲染用户列表
// ============================================================
async function renderUsers(filter = '') {
  let users = await Auth.getUsers();
  users.sort((a, b) => {
    if (a.role === 'admin' && b.role !== 'admin') return -1;
    if (a.role !== 'admin' && b.role === 'admin') return 1;
    return a.id - b.id;
  });

  if (filter) {
    users = users.filter(u => u.name.includes(filter) || u.route.includes(filter) || u.role.includes(filter));
  }

  const container = document.getElementById('userList');
  if (!users.length) {
    container.innerHTML = '<div class="admin-empty">暂无用户</div>';
    return;
  }

  const roleMap = { admin: '管理员', driver: '司机', delivery: '配送' };
  const roleClass = { admin: 'admin', driver: 'driver', delivery: 'delivery' };

  container.innerHTML = users.map(u => {
    const isAdmin = u.role === 'admin';
    const deleteBtn = isAdmin ? '' : `<button class="del-btn" onclick="deleteUser(${u.id})">删除</button>`;

    return `
      <div class="admin-list-item">
        <div class="info">
          <div class="name">${u.name || '(未命名)'}</div>
          <div class="sub">${u.route} · <span class="role-badge ${roleClass[u.role] || 'driver'}">${roleMap[u.role] || '司机'}</span></div>
        </div>
        <div class="actions">
          <button class="edit-btn" onclick="editUser(${u.id})">编辑</button>
          ${deleteBtn}
        </div>
      </div>
    `;
  }).join('');
}

function filterUsers() {
  renderUsers(document.getElementById('userSearch').value.trim());
}

// ============================================================
// 添加用户
// ============================================================
function showAddUserForm() {
  currentUserEditId = null;
  document.getElementById('userFormTitle').textContent = '添加用户';
  document.getElementById('userFormName').value = '';
  document.getElementById('userFormRoute').value = '';
  document.getElementById('userFormRole').value = 'driver';
  openDialog('userFormDialog');
}

// ============================================================
// 编辑用户
// ============================================================
function editUser(id) {
  const users = DB.get('users', []);
  const user = users.find(u => u.id === id);
  if (!user) return;

  currentUserEditId = id;

  if (user.role === 'admin') {
    document.getElementById('adminEditTitle').textContent = '修改管理员信息';
    document.getElementById('adminEditName').value = user.name || '';
    document.getElementById('adminEditName').placeholder = '修改管理员名称';
    document.getElementById('adminEditPassword').value = '';
    document.getElementById('adminEditPassword').placeholder = '修改管理员密码';
    document.getElementById('adminEditUnifiedPassword').value = '';
    document.getElementById('adminEditUnifiedPassword').placeholder = '修改企业统一密码';
    openDialog('adminEditDialog');
  } else {
    document.getElementById('userEditTitle').textContent = '编辑用户';
    document.getElementById('userEditName').value = user.name || '';
    document.getElementById('userEditName').placeholder = '用户名称';
    const routeNum = user.route.replace('号线', '');
    document.getElementById('userEditRoute').value = routeNum;
    document.getElementById('userEditRole').value = user.role || 'driver';
    openDialog('userEditDialog');
  }
}

// ============================================================
// 保存添加用户
// ============================================================
async function saveUser() {
  const rawName = document.getElementById('userFormName').value.trim();
  const rawRoute = document.getElementById('userFormRoute').value.trim();
  const role = document.getElementById('userFormRole').value;

  if (!rawRoute) { showToast('请填写线路编号', 'error'); return; }

  const route = formatRouteCode(rawRoute);
  if (!route) { showToast('请输入有效数字 (如 1, 17, 105)', 'error'); return; }

  const registered = await Auth.isRouteRegistered(route);
  if (registered) { showToast('该线路已存在用户', 'error'); return; }

  const name = rawName || '';
  const unifiedPassword = getUnifiedPassword();

  const newUser = await Auth.createUser(route, unifiedPassword, role, name);

  if (newUser) {
    DB.addLog('用户添加', `添加用户: ${route} (${role})`);
    showToast('用户已添加');
    closeDialog('userFormDialog');
    renderUsers();
  } else {
    showToast('用户添加失败，请重试', 'error');
  }
}

// ============================================================
// 保存编辑普通用户
// ============================================================
async function saveUserEdit() {
  const rawName = document.getElementById('userEditName').value.trim();
  const rawRoute = document.getElementById('userEditRoute').value.trim();
  const role = document.getElementById('userEditRole').value;

  if (!rawRoute) { showToast('请填写线路编号', 'error'); return; }

  const route = formatRouteCode(rawRoute);
  if (!route) { showToast('请输入有效数字 (如 1, 17, 105)', 'error'); return; }

  const users = await Auth.getUsers();
  const idx = users.findIndex(u => u.id === currentUserEditId);
  if (idx === -1) { showToast('用户不存在', 'error'); return; }

  const exists = users.some(u => u.route === route && u.id !== currentUserEditId);
  if (exists) { showToast('该线路已存在用户', 'error'); return; }

  users[idx].name = rawName || users[idx].name || '';
  users[idx].route = route;
  users[idx].role = role;

  await Auth.saveUsers(users);
  DB.addLog('用户编辑', `编辑用户: ${route} (${role})`);
  showToast('用户已更新');
  closeDialog('userEditDialog');
  renderUsers();
}

// ============================================================
// 保存编辑管理员
// ============================================================
async function saveAdminEdit() {
  const name = document.getElementById('adminEditName').value.trim();
  const adminPassword = document.getElementById('adminEditPassword').value.trim();
  const unifiedPassword = document.getElementById('adminEditUnifiedPassword').value.trim();

  let users = await Auth.getUsers();
  const idx = users.findIndex(u => u.id === currentUserEditId);

  if (idx === -1) {
    showToast('用户不存在', 'error');
    return;
  }

  if (name) users[idx].name = name;
  if (adminPassword) users[idx].password = adminPassword;

  if (unifiedPassword) {
    users.forEach(u => {
      if (u.role !== 'admin') u.password = unifiedPassword;
    });
    localStorage.setItem('unified_password', unifiedPassword);
  }

  await Auth.saveUsers(users);
  DB.addLog('管理员编辑', `编辑管理员: ${name || '管理员'}`);

  const currentRoute = Auth.getCurrentRoute();
  const adminRoutes = ['admin', '管理员', 'ADMIN'];
  if (adminRoutes.includes(currentRoute)) {
    localStorage.removeItem('loginStatus');
    localStorage.removeItem('currentRoute');
    localStorage.removeItem('currentUser');
    showToast('管理员信息已更新，请重新登录', 'warning');
    closeDialog('adminEditDialog');
    renderUsers();
    setTimeout(() => {
      window.location.href = 'index.html';
    }, 1500);
    return;
  }

  showToast('管理员信息已更新');
  closeDialog('adminEditDialog');
  renderUsers();
}

// ============================================================
// 删除用户（管理员不可删除）
// ============================================================
async function deleteUser(id) {
  const users = await Auth.getUsers();
  const user = users.find(u => u.id === id);

  if (user && user.role === 'admin') {
    showToast('管理员账户不可删除', 'warning');
    return;
  }

  if (!confirm('确定删除该用户吗？')) return;

  const updatedUsers = users.filter(u => u.id !== id);
  await Auth.saveUsers(updatedUsers);
  DB.addLog('用户删除', `删除用户: ${user?.route || id}`);
  showToast('用户已删除', 'warning');
  renderUsers();
}

// ============================================================
// 密码可见性切换
// ============================================================
function toggleAdminEditPassword() {
  const pwd = document.getElementById('adminEditPassword');
  pwd.type = pwd.type === 'password' ? 'text' : 'password';
}
function toggleAdminEditUnifiedPassword() {
  const pwd = document.getElementById('adminEditUnifiedPassword');
  pwd.type = pwd.type === 'password' ? 'text' : 'password';
}

// 暴露全局函数
window.openUserManagement = openUserManagement;
window.renderUsers = renderUsers;
window.filterUsers = filterUsers;
window.showAddUserForm = showAddUserForm;
window.editUser = editUser;
window.saveUser = saveUser;
window.saveUserEdit = saveUserEdit;
window.saveAdminEdit = saveAdminEdit;
window.deleteUser = deleteUser;
window.toggleAdminEditPassword = toggleAdminEditPassword;
window.toggleAdminEditUnifiedPassword = toggleAdminEditUnifiedPassword;