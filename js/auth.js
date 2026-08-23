async createRoute(route, password, role = 'driver', name = '') {
  const formattedRoute = this.formatRouteCode(route);
  if (!this.isValidRouteCode(formattedRoute)) return null;

  const existing = await this.findUserByRoute(formattedRoute);
  if (existing) return null;

  const newUser = await this.createUser(formattedRoute, password, role, name);
  if (!newUser) return null;

  // ===== 优先从黄金数据源加载（如果线路匹配） =====
  let stores = [];
  try {
    const resp = await fetch('/api/init');
    if (resp.ok) {
      const data = await resp.json();
      // 如果黄金数据存在，且匹配当前线路
      if (data.data && data.data.route === formattedRoute) {
        stores = data.data.stores;
      }
    }
  } catch (e) {
    // 黄金数据源不可用，使用默认
  }

  if (stores.length === 0) {
    // 如果黄金数据源没有匹配，使用默认3家门店
    stores = [
      { code: "01", name: "新门店_01", nav: "" },
      { code: "02", name: "新门店_02", nav: "" },
      { code: "03", name: "新门店_03", nav: "" }
    ];
  }

  // ... 继续保存
}