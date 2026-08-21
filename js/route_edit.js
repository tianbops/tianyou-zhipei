let editIndex = -1;
let stores = [];
let isDirty = false;
let isBatchMode = false;
let currentRoute = '';

function getRouteFromURL() {
  const urlParams = new URLSearchParams(window.location.search);
  const route = urlParams.get('route');
  return route ? decodeURIComponent(route) : Auth.getCurrentRoute();
}

function getReturnUrl() {
  const urlParams = new URLSearchParams(window.location.search);
  const from = urlParams.get('from');
  if (from === 'admin') return '../admin.html';
  const referrer = document.referrer || '';
  if (referrer.includes('admin.html')) return '../admin.html';
  if (referrer.includes('home.html')) return '../home.html';
  return '../home.html';
}

document.addEventListener('DOMContentLoaded', function() {
  if (!Auth.checkAuth()) return;
  currentRoute = getRouteFromURL();
  document.getElementById("routeName").textContent = currentRoute;
  const backBtn = document.getElementById('backBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  const returnUrl = getReturnUrl();
  backBtn.onclick = function() { goBack(returnUrl); };
  cancelBtn.onclick = function() { goBack(returnUrl); };
  loadStores(currentRoute);
});

function goBack(returnUrl) {
  if (isDirty && !confirm("有未保存的修改，确定离开吗？")) return;
  window.location.href = returnUrl || '../home.html';
}

async function loadStores(route) {
  const box = document.getElementById("storeList");
  box.innerHTML = '<div style="text-align:center;padding:20px;color:#7F8B98;">加载中...</div>';
  try {
    let data = Auth.getCachedRouteData(route);
    if (!data) {
      const response = await fetch(`/api/route/${encodeURIComponent(route)}`);
      if (response.ok) data = await response.json();
    }
    if (data && data.stores) { stores = data.stores; } 
    else { stores = [ { code: "01", name: "新门店_01", nav: "" }, { code: "02", name: "新门店_02", nav: "" }, { code: "03", name: "新门店_03", nav: "" } ]; }
    document.getElementById("storeCount").textContent = stores.length;
    renderStores();
  } catch (error) { console.error("加载失败:", error); stores = [ { code: "01", name: "新门店_01", nav: "" }, { code: "02", name: "新门店_02", nav: "" }, { code: "03", name: "新门店_03", nav: "" } ]; document.getElementById("storeCount").textContent = stores.length; renderStores(); }
}

function renderStores() {
  const box = document.getElementById("storeList");
  box.innerHTML = "";
  if (stores.length === 0) { box.innerHTML = '<div style="text-align:center;padding:20px;color:#7F8B98;">暂无客户，点击 + 新增</div>'; return; }
  stores.forEach(function(store, index) {
    box.innerHTML += `
      <div class="store-row">
        <div><span style="color:#7F8B98;margin-right:10px;">${store.code}</span>${store.name}</div>
        <div class="store-actions">
          ${store.nav ? `<button onclick="window.open('${store.nav}','_blank')" style="background:#2457A6;">导航</button>` : ''}
          <button onclick="editStore(${index})">编辑</button>
          <button onclick="deleteStore(${index})" style="background:#C0392B;">删除</button>
        </div>
      </div>
    `;
  });
}

function openAddDialog() {
  editIndex = -1; isBatchMode = true;
  document.getElementById("dialogTitle").textContent = "新增客户（批量录入）";
  document.getElementById("singleEditMode").style.display = "none";
  document.getElementById("batchEditMode").style.display = "block";
  document.getElementById("batchInput").value = '';
  document.getElementById("batchCharCount").textContent = '0 字符';
  document.getElementById("saveBtn").textContent = '批量导入';
  document.getElementById("storeDialog").style.display = "flex";
  const textarea = document.getElementById('batchInput');
  const charCount = document.getElementById('batchCharCount');
  textarea.addEventListener('input', function() { charCount.textContent = this.value.length + ' 字符'; });
}

function editStore(index) {
  editIndex = index; isBatchMode = false;
  const store = stores[index];
  document.getElementById("dialogTitle").textContent = "编辑客户";
  document.getElementById("singleEditMode").style.display = "block";
  document.getElementById("batchEditMode").style.display = "none";
  document.getElementById("storeCode").value = store.code;
  document.getElementById("storeName").value = store.name;
  document.getElementById("storeNav").value = store.nav || '';
  document.getElementById("saveBtn").textContent = '保存';
  document.getElementById("storeDialog").style.display = "flex";
}

function closeStoreDialog() { document.getElementById("storeDialog").style.display = "none"; }

function saveStore() {
  if (isBatchMode) { saveBatchStores(); } 
  else { saveSingleStore(); }
}

function saveSingleStore() {
  const code = document.getElementById("storeCode").value.trim();
  const name = document.getElementById("storeName").value.trim();
  const nav = document.getElementById("storeNav").value.trim();
  if (!code) { alert("请输入编号"); return; }
  if (!name) { alert("请输入客户名称"); return; }
  const newStore = { code, name, nav };
  if (editIndex === -1) { stores.push(newStore); } 
  else { stores[editIndex] = newStore; }
  sortAndRenumber(); isDirty = true; closeStoreDialog(); renderStores(); document.getElementById("storeCount").textContent = stores.length; saveToCache();
}

function saveBatchStores() {
  const rawText = document.getElementById('batchInput').value.trim();
  if (!rawText) { alert('⚠️ 请先录入客户数据'); return; }
  const lines = rawText.split('\n').filter(line => line.trim());
  const newStores = [];
  lines.forEach((line, index) => {
    let parts = line.split(/[|\t]/).map(s => s.trim()).filter(s => s);
    if (parts.length >= 1) {
      const name = parts[0] || `客户_${index + 1}`;
      const nav = parts[1] || '';
      newStores.push({ code: '', name, nav });
    }
  });
  if (newStores.length === 0) { alert('⚠️ 未能解析有效数据'); return; }
  stores = stores.concat(newStores);
  sortAndRenumber(); isDirty = true; closeStoreDialog(); renderStores(); document.getElementById("storeCount").textContent = stores.length; saveToCache();
  alert(`✅ 成功导入 ${newStores.length} 条客户数据`);
}

function sortAndRenumber() {
  stores.sort((a, b) => { const an = parseInt(a.code) || 999; const bn = parseInt(b.code) || 999; return an - bn; });
  stores.forEach((s, i) => { s.code = String(i + 1).padStart(2, '0'); });
}

function deleteStore(index) {
  if (!confirm("确定删除该客户吗？")) return;
  stores.splice(index, 1);
  sortAndRenumber(); isDirty = true; renderStores(); document.getElementById("storeCount").textContent = stores.length; saveToCache();
}

function saveToCache() {
  const route = currentRoute || Auth.getCurrentRoute();
  Auth.cacheRouteData(route, { route, stores });
  localStorage.setItem('base_data', JSON.stringify(stores));
}

async function updateDatabase() {
  if (!confirm("确认更新数据库吗？")) return;
  const route = currentRoute || Auth.getCurrentRoute();
  try {
    saveToCache();
    const response = await fetch(`/api/route/${encodeURIComponent(route)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stores })
    });
    if (response.ok) { Auth.addLog('数据库更新', `${route} 数据库已更新`); isDirty = false; alert("✅ 数据库更新成功"); } 
    else { Auth.addLog('数据库更新', `${route} 本地数据已更新`); isDirty = false; alert("✅ 数据已保存到本地"); }
  } catch (error) { Auth.addLog('数据库更新', `${route} 本地数据已更新`); isDirty = false; alert("✅ 数据已保存到本地"); }
  Auth.saveCurrentUserData();
}

async function pasteBatchContent() {
  try {
    const text = await navigator.clipboard.readText();
    document.getElementById('batchInput').value = text;
    document.getElementById('batchCharCount').textContent = text.length + ' 字符';
    showToast('✅ 已粘贴剪贴板内容');
  } catch (err) { alert('⚠️ 无法读取剪贴板'); }
}

function clearBatchInput() {
  if (confirm('确定清空输入内容吗？')) {
    document.getElementById('batchInput').value = '';
    document.getElementById('batchCharCount').textContent = '0 字符';
    showToast('已清空', 'warning');
  }
}

function loadBatchExample() {
  const example = `江北胡汪洋经销商 | https://surl.amap.com/zTkZfPL2fP
渝北中景隆贸易有限公司
江北重庆兴农融资担保集团有限公司
江北重庆三峡融资担保集团有限公司
渝北Q312重庆沁园松石北路店 | https://surl.amap.com/L0E65r1hcQ0`;
  document.getElementById('batchInput').value = example;
  document.getElementById('batchCharCount').textContent = example.length + ' 字符';
  showToast('📝 示例数据已加载');
}

function showToast(msg, type = 'success') {
  const toast = document.getElementById('toast');
  if (!toast) {
    const div = document.createElement('div');
    div.id = 'toast';
    div.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#18212B;color:#fff;padding:12px 24px;border-radius:12px;z-index:9999;font-size:14px;max-width:90%;text-align:center;border-left:4px solid #27AE60;';
    document.body.appendChild(div);
    div.textContent = msg;
    setTimeout(() => div.remove(), 3000);
    return;
  }
  toast.textContent = msg;
  toast.style.display = 'block';
  toast.className = 'toast show ' + type;
  setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

window.addEventListener('beforeunload', function(e) {
  if (isDirty) { e.preventDefault(); e.returnValue = '有未保存的修改'; }
});
