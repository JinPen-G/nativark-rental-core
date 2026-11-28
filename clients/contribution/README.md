# Rental 客户与员工贡献

正式源码出口 `@rental-os/rental-core/clients/contribution` 提供 `createRentalCustomerClient(options)`、`createRentalStaffClient(options)`。两者分别返回 `session`、`access`、`contribution`，供通用 Web 与微信外壳复用。此目录不渲染页面、不依赖 DOM、微信全局、AI 或附件存储；订单、范围、动作和原收据留在 Rental。

本片合同固定为 [Zelo 63340342ae46ef545f0078f2a035dfdc62703874](https://github.com/JinPen-G/Zelo/commit/63340342ae46ef545f0078f2a035dfdc62703874) 的 `@rental-os/platform-client-contracts`。该合同尚未合入 main，也不是已发布安装包。只有选择通用客户端的组合才提供这一可选 peer；原官网、SDK 与普通 Rental 服务端不需要它。消费方以该固定源码包装配，不能替换为浮动分支。

```ts
import { createRentalCustomerClient } from '@rental-os/rental-core/clients/contribution';
import { createClientRuntime, createClientOperations } from '@rental-os/platform-client-contracts';

const rental = createRentalCustomerClient({
  version: rentalVersion, tenantCode, clientId: 'website',
  transport, credentials, createOperationKey,
});
const runtime = createClientRuntime({
  surface: 'customer-web', session: rental.session, access: rental.access,
  contributions: [rental.contribution],
});
const operations = createClientOperations(runtime, operationStore);
```

员工改用 `createRentalStaffClient` 和 `staff-web`；微信分别选 `wechat-customer`、`wechat-staff`，客户 `clientId` 采用原 `miniprogram:<appId>`。宿主供给原可信 API 地址的运输、同步凭据存储、安全随机原键生成器，以及按通用合同持久化的 `operationStore`。运输接收 Rental 固定完整路径，注入明确传入的 authorization 和 Idempotency-Key，只发送一次，解包原业务 JSON；不得自动刷新后重发、采用登录响应或由旧 401 清除新会话。HTTP 拒绝可抛 `RentalClientHttpError(status)`，其他失败保持不可用/未知。`lifetime` 可用于取消网络，取消本身不证明业务回滚。

`session.signIn` 在原登录和当前上下文均成功且寿命有效后才保存凭据；`signOut` 同步清除本机身份，再尽力撤销捕获的原刷新令牌。`refresh` 复核现有会话，过期时重新登录，本片不做自动令牌轮换。客户空间选择提交原服务核定的 workspaceCode。员工选项明确区分“经营空间”与“门店”：空间沿原 switch-workspace；门店来自当前空间 GET `/api/staff/v1/rental/v1/contribution-locations`，仅返回原订单查看权及地点/dataScope允许的启用地点 ID、名称。采用结果再读可信上下文，门店选择保存到 `scope.locationId`，不会改变原会话授权。客户与员工须使用独立凭据槽和操作存储分区。

| 分面 | 页面及动作 | 原业务出口 |
| --- | --- | --- |
| 普通客户 | `rental.my-orders` → `rental.my-order` / `cancel` | 当前空间本人订单，POST `/api/client/v1/orders/:id/cancel`；GET `/api/client/v1/orders/:id/cancel-receipt` |
| 员工 | `rental.service-orders` → `rental.service-order` → `rental.service-occurrence` / `start` | POST `/api/staff/v1/rental/v1/orders/:id/services/:occurrenceId/execution`，固定 `{action:"start"}`；GET 同级 `/execution-receipt` |

客户不要求企业关系。取消沿原会员资格、订单归属、取消费与事务规则。员工要求原 `rental-os:order:view` 读权限及 `rental-os:order:operate` 动作权限，继续受租户、空间、地点和 dataScope 约束；员工分面仅允许带原键的 `start`，未连带开放完成、取消服务或退款。列表首期最多展示当前空间 50 笔，不包含跨空间操作和全量搜索。选定门店时，运输带 `x-rental-location-id`；服务端分页前与原权限求交，详情、服务发生项及原收据继续核定同一地点。员工仅本人数据范围不提供共享门店选择。切换门店使旧请求和旧鉴权结果失效；原键按完整身份/空间/地点分区保留，不能用另一个门店重发未知操作。未选门店时明确显示经营空间范围。

身份观察为 GET `/api/client/v1/auth/contribution-context`、`/api/staff/v1/auth/contribution-context`。它们从原 Auth/Guard 返回最小主体、空间、会话与权限指纹，不下发原 Session ID 或令牌。`access.authorize` 按三个目的分别走真实门禁：`page` 请求 GET `/api/client/v1/contribution-page-access` 或 `/api/staff/v1/rental/v1/contribution-page-access`，核当前普通 Core 准入及原本人/员工订单读权和范围，不要求 `canAct` 或 `order:operate`；`action` 请求原 `contribution-access`，复核普通 Core 与当前动作权；`original_receipt` 沿原历史订单读门禁，实际收据再核原操作和对象。普通页面停用不堵住独立善后读取，历史许可也不授权普通直达页。实际页面对象和业务写入继续独立校验原权限、归属与事务条件。

原取消收据只查既有 `order.cancel` 账，要求当前本人订单和原记录都对应同一租户、订单及本人；缺记录返回 `unknown`，当前已取消状态不能替代原收据。员工复用原 `order.service-execution` 账及已存在的只读收据，完成后的原开始凭据仍按原 startAt 核验。原生 SDK 另提供 `createRentalMiniProgramOrdersApi().readCancellationReceipt`、`createRentalStaffOrdersApi().startServiceOccurrence/readServiceExecutionReceipt`。

外壳必须先保存原引用再执行。写入及后续读取失应答均保留原键，`readReceipt` 从不发送 POST，也不生成替代键。该策略没有“未提交”证据时不会将失败改成可自动重试。服务端业务状态拒绝后没有已记录收据的操作仍可能保持未知，需人工核对，不能清除引用后自动再试。

必要类型检查：在已包含固定可选合同的组合开发工作区执行 `npm run lint:client-contribution -w @rental-os/rental-core`。源码出口由 Web/微信编译器编译；需要独立 CommonJS 输出时用 `build:client-contribution`，输出 `dist-contribution`。原服务端、原生 SDK 和 OpenAPI 仍沿根 README 的既有构建入口。离线类型或替身行为不代表真实 Auth/数据库、浏览器及微信宿主已验收；本片无迁移、部署或真实环境调用。
