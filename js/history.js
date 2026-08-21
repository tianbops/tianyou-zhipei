let selectDate = new Date().toISOString().split('T')[0];
let historyData = [];

document.addEventListener('DOMContentLoaded', function() {
  if (!Auth.checkAuth()) return;
  document.getElementById("historyDate").textContent = `📅 ${selectDate} ▼`;
  loadHistory(selectDate);
});

async function loadHistory(date) {
  const box = document.getElementById("historyList");
  box.innerHTML = '<div class="empty-tip">加载中...</div>';
  try {
    const allHistory = JSON.parse(localStorage.getItem('delivery_history') || '[]');
    const filtered = allHistory.filter(item => item.date === date);
    if (filtered.length > 0) { historyData = filtered; renderHistory(filtered); }
    else { 
      try {
        const response = await fetch(`/api/history/${date}`);
        if (response.ok) { const data = await response.json(); if (data && data.length) { historyData = data; renderHistory(data); return; } }
      } catch (e) { console.log('API不可用'); }
      box.innerHTML = '<div class="empty-tip">📭 暂无配送记录</div>';
    }
  } catch (error) { box.innerHTML = '<div class="empty-tip">加载失败，请重试</div>'; }
}

function renderHistory(records) {
  const box = document.getElementById("historyList");
  box.innerHTML = "";
  if (!records || !records.length) { box.innerHTML = '<div class="empty-tip">📭 暂无配送记录</div>'; return; }
  records.forEach(function(item, index) {
    const orderCount = item.count || (item.orders ? item.orders.length : 0);
    const weight = item.weight || '0.0 kg';
    const route = item.route || Auth.getCurrentRoute();
    const vehicle = item.vehicle || '渝DK7692';
    const date = item.date || '未知日期';
    box.innerHTML += `
      <div class="history-item">
        <div class="history-date">📅 ${date}</div>
        <div class="info-row"><span class="label">线路</span><span class="value">${route}</span></div>
        <div class="info-row"><span class="label">车辆</span><span class="value">🚚 ${vehicle}</span></div>
        <div class="info-row"><span class="label">配送</span><span class="value">${orderCount} 家门店</span></div>
        <div class="info-row"><span class="label">总重量</span><span class="value">${weight}</span></div>
        <button class="history-btn" onclick="viewHistoryDetail(${index})">查看路线 →</button>
      </div>
    `;
  });
}

function viewHistoryDetail(index) {
  const item = historyData[index];
  if (!item) { alert('数据不存在'); return; }
  localStorage.setItem('history_view_data', JSON.stringify(item));
  window.location.href = 'order_detail.html?mode=history';
}

function openDatePicker() {
  const dialog = document.getElementById("dateDialog");
  dialog.style.display = "flex";
  const dateParts = selectDate.split('-');
  const yearSelect = document.getElementById("yearSelect"), monthSelect = document.getElementById("monthSelect"), daySelect = document.getElementById("daySelect");
  const currentYear = new Date().getFullYear();
  yearSelect.innerHTML = ''; 
  for (let i = currentYear - 5; i <= currentYear; i++) {
    yearSelect.innerHTML += `<option value="${i}">${i}年</option>`;
  }
  monthSelect.innerHTML = ''; 
  for (let i = 1; i <= 12; i++) {
    monthSelect.innerHTML += `<option value="${String(i).padStart(2,'0')}">${i}月</option>`;
  }
  const daysInMonth = new Date(parseInt(dateParts[0]), parseInt(dateParts[1]), 0).getDate();
  daySelect.innerHTML = ''; 
  for (let i = 1; i <= daysInMonth; i++) {
    daySelect.innerHTML += `<option value="${String(i).padStart(2,'0')}">${i}日</option>`;
  }
  if (dateParts.length === 3) { yearSelect.value = dateParts[0]; monthSelect.value = dateParts[1]; daySelect.value = dateParts[2]; }
}

function closeDatePicker() { document.getElementById("dateDialog").style.display = "none"; }

function confirmDate() {
  const year = document.getElementById("yearSelect").value, month = document.getElementById("monthSelect").value, day = document.getElementById("daySelect").value;
  selectDate = `${year}-${month}-${day}`;
  document.getElementById("historyDate").textContent = `📅 ${selectDate} ▼`;
  closeDatePicker();
  loadHistory(selectDate);
}

function goBack() { window.location.href = "../home.html"; }
