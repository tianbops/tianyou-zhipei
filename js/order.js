// ============================================================
// 今日运单详情 - 菜单和功能
// ============================================================

function toggleMenu() {
  const menu = document.getElementById("menuPanel");
  if (menu) {
    menu.style.display = menu.style.display === "block" ? "none" : "block";
  }
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
  if (vehicle === "") {
    alert("请输入车辆号码");
    return;
  }
  localStorage.setItem("today_temp_vehicle", vehicle);
  document.getElementById("vehicleText").innerHTML = vehicle + "（临时）";
  closeVehicle();
}

function shareOrder() {
  if (navigator.share) {
    navigator.share({
      title: "天友智配One 今日运单",
      text: "今日配送任务"
    });
  } else {
    alert("分享功能将在后续版本接入");
  }
}

function goHome() {
  window.location.href = "../home.html";
}

function openRouteEdit() {
  window.location.href = "route_edit.html";
}

function logout() {
  if (confirm("确定退出登录吗？")) {
    Auth.logout();
  }
}

function saveTodayHistory() {
  const today = new Date().toISOString().substring(0, 10);
  const vehicle = localStorage.getItem("today_temp_vehicle") || "渝DK7692";
  
  let routeData = JSON.parse(localStorage.getItem("history_route_data")) || 
                  JSON.parse(localStorage.getItem("base_data")) || [];
  
  let history = JSON.parse(localStorage.getItem("delivery_history")) || [];
  
  const record = {
    date: today,
    line: "01号线",
    vehicle: vehicle,
    count: routeData.length,
    weight: "368.5kg"
  };
  
  const index = history.findIndex(function(item) {
    return item.date === today;
  });
  
  if (index >= 0) {
    history[index] = record;
  } else {
    history.unshift(record);
  }
  
  localStorage.setItem("delivery_history", JSON.stringify(history));
}

function showHistoryDate() {
  const date = localStorage.getItem("history_view_date");
  if (!date) return;
  
  const title = document.querySelector(".top-row div:last-child");
  if (title) {
    title.innerHTML = date;
  }
}

window.onload = function() {
  renderRoute();
  saveTodayHistory();
  showHistoryDate();
  
  const tempVehicle = localStorage.getItem("today_temp_vehicle");
  if (tempVehicle) {
    document.getElementById("vehicleText").innerHTML = tempVehicle + "（临时）";
    document.querySelector(".label").innerHTML = "临时用车：";
  }
};
