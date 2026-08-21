document.addEventListener('DOMContentLoaded', function() {
  if (!Auth.checkAuth()) return;
  const route = Auth.getCurrentRoute();
  document.getElementById("routeName").textContent = route;
  document.getElementById("menuRoute").textContent = route;
  document.getElementById("todayDate").textContent = new Date().toISOString().split('T')[0];
  const vehicle = localStorage.getItem("today_vehicle") || "渝DK7692";
  document.getElementById("vehicleText").textContent = vehicle;
  loadTodayData(route);
});

function loadTodayData(route) {
  const listEl = document.getElementById("routeList");
  const storeCountEl = document.getElementById("storeCount");
  const totalWeightEl = document.getElementById("totalWeight");
  
  const todayOrders = getTodayOrders();
  
  if (todayOrders && todayOrders.length > 0) {
    const count = todayOrders.length;
    let totalWeight = 0;
    todayOrders.forEach(order => {
      const weight = parseFloat(order.weight) || 0;
      totalWeight += weight;
    });
    storeCountEl.textContent = count;
    totalWeightEl.textContent = totalWeight.toFixed(1) + ' kg';
    renderRoute(todayOrders);
  } else {
    storeCountEl.textContent = '0';
    totalWeightEl.textContent = '无数据';
    listEl.innerHTML = '<div class="empty-tip">今日暂无配送数据</div>';
  }
}

function getTodayOrders() {
  try {
    const data = localStorage.getItem('today_orders');
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
}

function renderRoute(stores) {
  const box = document.getElementById("routeList");
  if (!box) return;
  box.innerHTML = "";
  if (!stores || stores.length === 0) {
    box.innerHTML = '<div class="empty-tip">今日暂无配送数据</div>';
    return;
  }
  stores.forEach(function(store, index) {
    const statusMap = { '待配送': '⏳ 待配送', '配送中': '🚚 配送中', '已送达': '✅ 已送达' };
    const statusText = statusMap[store.status] || '⏳ 待配送';
    const weightText = store.weight ? store.weight + 'kg' : '';
    box.innerHTML += `
      <div class="store-item">
        <div>
          <span style="color:#7F8B98;margin-right:8px;">${index + 1}</span>
          ${store.name}
          ${weightText ? `<span style="color:#7F8B98;font-size:12px;margin-left:6px;">${weightText}</span>` : ''}
        </div>
        <div style="display:flex;gap:6px;align-items:center;">
          <span style="font-size:12px;color:#7F8B98;">${statusText}</span>
          <button onclick="openNavigation('${store.nav || ''}')">导航</button>
          <button onclick="markDelivered(${index})" style="background:#27AE60;">送达</button>
        </div>
      </div>
    `;
  });
}

function openNavigation(nav) {
  if (nav) { window.open(nav, '_blank'); } 
  else { alert('该门店暂无导航地址'); }
}

function markDelivered(index) {
  if (!confirm('确认该门店已送达？')) return;
  const todayOrders = getTodayOrders();
  if (todayOrders && todayOrders[index]) {
    todayOrders[index].status = '已送达';
    localStorage.setItem('today_orders', JSON.stringify(todayOrders));
    updateHistory(todayOrders);
    renderRoute(todayOrders);
    Auth.addLog('门店送达', `送达门店: ${todayOrders[index].name}`);
    alert('✅ 已标记为送达');
  }
}

function updateHistory(orders) {
  const today = new Date().toISOString().split('T')[0];
  const route = Auth.getCurrentRoute();
  let history = JSON.parse(localStorage.getItem('delivery_history') || '[]');
  let totalWeight = 0;
  orders.forEach(order => { const weight = parseFloat(order.weight) || 0; totalWeight += weight; });
  const record = { date: today, route, vehicle: localStorage.getItem('today_vehicle') || '渝DK7692', count: orders.length, weight: totalWeight.toFixed(1) + ' kg', orders };
  const index = history.findIndex(item => item.date === today);
  if (index >= 0) { history[index] = record; } 
  else { history.unshift(record); }
  localStorage.setItem('delivery_history', JSON.stringify(history));
  Auth.saveCurrentUserData();
}

function toggleMenu() {
  const menu = document.getElementById("menuPanel");
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}

document.addEventListener("click", function(e) {
  const menu = document.getElementById("menuPanel");
  const btn = document.querySelector(".menu-btn");
  if (menu && !menu.contains(e.target) && !btn?.contains(e.target)) {
    menu.style.display = "none";
  }
});

function openVehicle() {
  document.getElementById("vehicleDialog").style.display = "flex";
  document.getElementById("menuPanel").style.display = "none";
}

function closeVehicle() {
  document.getElementById("vehicleDialog").style.display = "none";
}

function saveVehicle() {
  const vehicle = document.getElementById("newVehicle").value.trim();
  if (!vehicle) { alert("请输入车辆号码"); return; }
  localStorage.setItem("today_vehicle", vehicle);
  document.getElementById("vehicleText").textContent = vehicle;
  closeVehicle();
  Auth.addLog('车辆更换', `更换车辆为: ${vehicle}`);
}

function shareOrder() {
  if (navigator.share) {
    navigator.share({ title: "天友智配One 今日运单", text: `今日配送任务 - ${Auth.getCurrentRoute()}`, url: window.location.href });
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(window.location.href).then(() => alert('📋 链接已复制'));
  } else {
    alert('分享功能: 请复制链接分享');
  }
}

function goBack() { window.location.href = "../home.html"; }
function logout() { if (confirm("确定退出登录吗？")) { Auth.logout(); } }
