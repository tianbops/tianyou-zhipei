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
