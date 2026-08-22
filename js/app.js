// ============================================================
// 应用入口 - 全局功能
// ============================================================

// 首页菜单
function openHomeMenu() {
  const menu = document.getElementById("homeMenu");
  if (menu) {
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  }
}

// 退出登录
function logout() {
  if (confirm("确定退出登录吗？")) {
    Auth.logout();
  }
}

// 线路编辑跳转
function openRouteEdit() {
  window.location.href = "pages/route_edit.html";
}

// 进入管理中心
function goToAdmin() {
  window.location.href = "admin.html";
}

// 点击外部关闭菜单
document.addEventListener("click", function(e) {
  const menu = document.getElementById("homeMenu");
  const btn = document.querySelector(".menu-btn");
  if (menu && !menu.contains(e.target) && !btn?.contains(e.target)) {
    menu.style.display = "none";
  }
});

// 上传弹窗
document.addEventListener('DOMContentLoaded', function() {
  const uploadBtn = document.querySelector(".upload-btn");
  const uploadOverlay = document.querySelector(".upload-overlay");
  const cancelBtn = document.querySelector(".cancel-btn");
  
  if (uploadBtn && uploadOverlay) {
    uploadBtn.onclick = function() {
      uploadOverlay.style.display = "block";
    };
  }
  
  if (cancelBtn && uploadOverlay) {
    cancelBtn.onclick = function() {
      uploadOverlay.style.display = "none";
    };
  }
  
  if (uploadOverlay) {
    uploadOverlay.onclick = function(e) {
      if (e.target === uploadOverlay) {
        uploadOverlay.style.display = "none";
      }
    };
  }
});
