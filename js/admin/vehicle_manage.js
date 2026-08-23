// js/admin/vehicle_manage.js
// 车辆管理模块

let currentVehicleEditId = null;
let currentVehicleStatus = 'active';

// ============================================================
// 打开车辆管理
// ============================================================
function openVehicleManagement() {
  openDialog('vehicleDialog');
  renderVehicles();
}

// ============================================================
// 渲染车辆列表
// ============================================================
function renderVehicles(filter = '') {
  let vehicles = DB.get('vehicles', []);
  if (filter) vehicles = vehicles.filter(v => v.plate.includes(filter) || v.route.includes(filter));
  const container = document.getElementById('vehicleList');
  if (!vehicles.length) {
    container.innerHTML = '<div class="admin-empty">暂无车辆</div>';
    return;
  }
  container.innerHTML = vehicles.map(v => `
    <div class="admin-list-item">
      <div class="info">
        <div class="name">${v.plate}</div>
        <div class="sub">${v.route} · <span class="status-badge ${v.status === 'active' ? 'active' : 'inactive'}">${v.status === 'active' ? '启用' : '停用'}</span></div>
      </div>
      <div class="actions">
        <button class="edit-btn" onclick="editVehicle(${v.id})">编辑</button>
        <button class="del-btn" onclick="deleteVehicle(${v.id})">删除</button>
      </div>
    </div>
  `).join('');
}

function filterVehicles() {
  renderVehicles(document.getElementById('vehicleSearch').value.trim());
}

// ============================================================
// 状态切换
// ============================================================
function setVehicleStatus(status) {
  currentVehicleStatus = status;
  const activeBtn = document.getElementById('vehicleStatusActive');
  const inactiveBtn = document.getElementById('vehicleStatusInactive');
  if (status === 'active') {
    activeBtn.classList.add('active');
    inactiveBtn.classList.remove('active');
  } else {
    inactiveBtn.classList.add('active');
    activeBtn.classList.remove('active');
  }
}

function setVehicleEditStatus(status) {
  currentVehicleStatus = status;
  const activeBtn = document.getElementById('vehicleEditStatusActive');
  const inactiveBtn = document.getElementById('vehicleEditStatusInactive');
  if (status === 'active') {
    activeBtn.classList.add('active');
    inactiveBtn.classList.remove('active');
  } else {
    inactiveBtn.classList.add('active');
    activeBtn.classList.remove('active');
  }
}

// ============================================================
// 添加车辆
// ============================================================
function showAddVehicleForm() {
  currentVehicleEditId = null;
  currentVehicleStatus = 'active';
  document.getElementById('vehicleFormTitle').textContent = '添加车辆';
  document.getElementById('vehicleFormPlate').value = '';
  document.getElementById('vehicleFormRoute').value = '';
  document.getElementById('vehicleStatusActive').classList.add('active');
  document.getElementById('vehicleStatusInactive').classList.remove('active');
  openDialog('vehicleFormDialog');
}

async function saveVehicle() {
  const plate = document.getElementById('vehicleFormPlate').value.trim();
  const rawRoute = document.getElementById('vehicleFormRoute').value.trim();
  const status = currentVehicleStatus;

  if (!plate) { showToast('请输入车牌号', 'error'); return; }
  if (!rawRoute) { showToast('请输入线路编号', 'error'); return; }

  const route = formatRouteCode(rawRoute);
  if (!route) { showToast('请输入有效数字 (如 1, 17, 105)', 'error'); return; }

  const registered = await isRouteRegistered(route);
  if (!registered) { showToast('❌ 该线路未开通', 'error'); return; }

  let vehicles = DB.get('vehicles', []);
  const exists = vehicles.some(v => v.plate === plate);
  if (exists) { showToast('该车牌已存在', 'error'); return; }

  const maxId = vehicles.reduce((max, v) => Math.max(max, v.id), 0);
  vehicles.push({ id: maxId + 1, plate, route, status });
  DB.set('vehicles', vehicles);
  DB.addLog('车辆添加', `添加车辆: ${plate} (${route})`);
  showToast('车辆已添加');
  closeDialog('vehicleFormDialog');
  renderVehicles();
}

// ============================================================
// 编辑车辆（无线路修改）
// ============================================================
function editVehicle(id) {
  const vehicles = DB.get('vehicles', []);
  const v = vehicles.find(v => v.id === id);
  if (!v) return;

  currentVehicleEditId = id;
  currentVehicleStatus = v.status || 'active';
  document.getElementById('vehicleEditTitle').textContent = '编辑车辆';
  document.getElementById('vehicleEditPlate').value = v.plate;

  const activeBtn = document.getElementById('vehicleEditStatusActive');
  const inactiveBtn = document.getElementById('vehicleEditStatusInactive');
  if (v.status === 'active') {
    activeBtn.classList.add('active');
    inactiveBtn.classList.remove('active');
  } else {
    inactiveBtn.classList.add('active');
    activeBtn.classList.remove('active');
  }

  openDialog('vehicleEditDialog');
}

function saveVehicleEdit() {
  const plate = document.getElementById('vehicleEditPlate').value.trim();
  const status = currentVehicleStatus;

  if (!plate) { showToast('请输入车牌号', 'error'); return; }

  let vehicles = DB.get('vehicles', []);
  const idx = vehicles.findIndex(v => v.id === currentVehicleEditId);
  if (idx === -1) { showToast('车辆不存在', 'error'); return; }

  const exists = vehicles.some(v => v.plate === plate && v.id !== currentVehicleEditId);
  if (exists) { showToast('该车牌已存在', 'error'); return; }

  vehicles[idx].plate = plate;
  vehicles[idx].status = status;

  DB.set('vehicles', vehicles);
  DB.addLog('车辆编辑', `编辑车辆: ${plate}`);
  showToast('车辆已更新');
  closeDialog('vehicleEditDialog');
  renderVehicles();
}

// ============================================================
// 删除车辆
// ============================================================
function deleteVehicle(id) {
  if (!confirm('确定删除该车辆吗？')) return;
  let vehicles = DB.get('vehicles', []);
  const v = vehicles.find(v => v.id === id);
  vehicles = vehicles.filter(v => v.id !== id);
  DB.set('vehicles', vehicles);
  DB.addLog('车辆删除', `删除车辆: ${v?.plate || id}`);
  showToast('车辆已删除', 'warning');
  renderVehicles();
}

// 暴露全局函数
window.openVehicleManagement = openVehicleManagement;
window.renderVehicles = renderVehicles;
window.filterVehicles = filterVehicles;
window.showAddVehicleForm = showAddVehicleForm;
window.saveVehicle = saveVehicle;
window.editVehicle = editVehicle;
window.saveVehicleEdit = saveVehicleEdit;
window.deleteVehicle = deleteVehicle;
window.setVehicleStatus = setVehicleStatus;
window.setVehicleEditStatus = setVehicleEditStatus;