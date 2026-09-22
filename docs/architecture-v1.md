# 天友智配One V1.0 统一架构基线

## 1. 核心原则

- 一个用户只有一个 User ID。
- Web、微信小程序、Android 共用同一用户身份。
- 路线是独立且唯一的系统实体，不属于某个用户。
- 一条路线最多绑定一名驾驶员和一名配送员。
- 一个用户最多绑定一条路线。
- 所有正常用户均可调度/使用任意路线。
- 只有绑定该路线的用户可以维护该路线基准数据库。
- 系统管理员负责用户、权限、绑定关系、账号和系统日志，不因 system_admin 身份获得业务基准库修改权。
- “绑定路线”和“当前调度路线”严格分离。

## 2. 数据归属

### 用户
`user:{userId}`

保存账号、角色、个人资料、绑定路线、会话版本等。

### 路线
`route:{routeId}`

保存路线身份、驾驶员、配送员、绑定用户列表。

### 路线基准库
`route:{routeId}:base`

一条路线只有一个基准库。

### 路线业务数据
`route:{routeId}:orders:today:{date}`
`route:{routeId}:orders:history:{date}`
`route:{routeId}:orders:latest`

订单/历史按路线归属，而不是按登录用户复制。

### 路线学习库
`route:{routeId}:learning`

学习数据随路线共享；写入维护权遵循路线绑定关系。

## 3. 客户端

- Web
- 微信小程序
- Android

统一调用服务器 API，业务判断不得复制到客户端。

## 4. 认证

- Web：HttpOnly Cookie
- 微信小程序：Bearer Token
- Android：Bearer Token
- Token 中包含 sessionVersion。
- 服务端每次认证回读用户资料，停用账号或 sessionVersion 变化后旧会话立即失效。

## 5. 权限

### driver / 普通配送用户
可使用任意路线；只能修改自己绑定路线的业务基准数据。

### route_admin
保留为兼容角色；路线业务修改权仍必须满足“绑定该路线”条件。

### system_admin
只管理系统，不默认拥有业务基准库修改权。

## 6. 兼容迁移

V1.0 支持从旧版
`user:{userId}:route:{route}:base`
迁移到新的
`route:{route}:base`。

迁移后路线基准库以路线实体为唯一真实来源。

## 7. 管理后台

第一阶段管理范围：

- 用户列表
- 用户启用/停用
- 角色
- 路线绑定
- 驾驶员/配送员身份
- 密码重置
- 多端会话失效
- 系统管理日志

不直接管理：

- 运单
- 今日配送
- 历史配送
- 门店业务数据
- 路线基准库内容

## 8. 客户端扩展

新增客户端原则：

`Client -> Unified API -> Service/Business -> Repository -> Upstash`

Android 不需要复制 Web 业务逻辑；微信小程序同样使用统一业务引擎。
