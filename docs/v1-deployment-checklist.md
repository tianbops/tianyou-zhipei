# V1.0 发布前配置

## 必要环境变量

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `SESSION_SECRET`

## 首个系统管理员

新增：
- `ADMIN_BOOTSTRAP_KEY`

首次部署后：

1. 保证目标用户已经注册。
2. POST `/api/admin/bootstrap`。
3. Header：`X-Admin-Bootstrap-Key: <ADMIN_BOOTSTRAP_KEY>`
4. Body：`{"username":"目标用户名"}` 或 `{"userId":"目标User ID"}`。
5. 初始化成功后立即轮换/删除 `ADMIN_BOOTSTRAP_KEY`。

系统管理员登录后访问 `/admin.html`。

## 注意

管理员后台不提供基准库业务编辑入口。路线基准库仍由该路线绑定的驾驶员/配送员在“线路编辑”中维护。

## 全量业务数据重置

智配One提供受保护的 `POST /api/admin/data-reset`。

执行条件：

1. 当前请求必须是系统管理员会话。
2. Cloudflare Pages/Functions 环境变量中配置一次性的 `DATA_RESET_KEY`。
3. Header：`X-Data-Reset-Key: <DATA_RESET_KEY>`
4. Body 必须包含精确确认词：

```json
{"confirmation":"确认清空智配One数据"}
```

重置范围仅包括代码已核实的智配One业务键：

- `user:*`
- `route:*`
- `lock:*`
- `system:admin:logs`
- `system:admin:bootstrap:used`
- `wx:openid:*`
- `wx:unionid:*`

不会执行 `FLUSHDB`，不会修改 GitHub 代码，也不会修改 Cloudflare 环境变量。

### 重置后的初始化顺序

1. 删除旧业务数据。
2. 删除/轮换 `DATA_RESET_KEY`，避免重复执行。
3. 重新注册首个用户。
4. 使用 `ADMIN_BOOTSTRAP_KEY` 初始化系统管理员。
5. 创建 17号线、18号线。
6. 建立用户与线路绑定。
7. 分别导入/建立两条线路基准门店库。
8. 配置车辆。
9. 执行解析、确认、历史、跨用户调度回归测试。

### 重要安全规则

- 不要对 Upstash 执行 `FLUSHDB`。
- 如果 Redis 与其他应用共用，必须先确认上述命名空间全部属于智配One。
- 数据重置接口只用于 V1.0 初始化/测试，不应作为日常功能开放。
