# Rental 独立 API

普通入口使用同一所选 Prisma Client 连接 Zelo 公共能力与 Rental 业务。授权、订单、库存、原收据和后台所用接口仍走原处理器。新装 AI 是显式选择；普通入口不会加载 AI 或 MCP。

先按照[双仓准备步骤](https://github.com/JinPen-G/Zelo-rental-core#源码开发工作区)从固定版本准备 `host` 或 `full`，在解包后的组合根目录安装锁定依赖并执行 `npm run check:types`。构建前按[宿主开发说明](https://github.com/JinPen-G/Zelo/blob/6c41063f8be4d3ac02d4857c87ec2712a5aa6755/apps/rental-api/README.md)分别准备公共与所选 Rental Client，明确设置 `RENTAL_PRISMA_CLIENT` 后执行 `npm run build`；不要使用默认 Prisma Client。构建无需启动服务。部署和运行 `npm run start -w @rental-os/rental-api` 还须准备固定 Core 包、部署锁、数据库和原迁移账。

## 固定双仓普通开发运行包

从已按锁准备编译依赖的 Zelo Git 根目录运行以下命令。两个 SHA 都使用完整提交；归档路径须为尚不存在的绝对路径。`6c41063f8be4d3ac02d4857c87ec2712a5aa6755` 是已包含该工具的 Zelo 示例提交。

```sh
node scripts/package-rental-host.cjs --development --repo <Zelo目录> --repository https://github.com/JinPen-G/Nativark --commit <Zelo完整SHA> --core-repo <Rental目录> --core-commit <Rental完整SHA> --output <新归档绝对路径.tgz>
```

解包后按归档 README 安装原锁依赖、生成两份所选 Client、验证运行包和迁移。只对为本次启动准备的空 MySQL 库应用归档内 `apps/rental-api/prisma-deployment` 的迁移；该开发入口不接管旧库。设置该库的 `DATABASE_URL` 与本机 `AUTH_TOKEN_SECRET`，按归档步骤初始化。`RENTAL_AI_MODE=disabled`、`RENTAL_DEPLOYMENT_LOCK` 指向随包锁的绝对路径，启动 `node apps/rental-api/dist/main.js` 后检查 `/api/health`。API 和后台须使用同一个包与锁。开发归档不满足正式版本 Tag 或服务器更新资格。

## 新装 Rental 与公共 AI

在包含 v2 构建工具的固定 Zelo 检出，执行上面的命令，在 `--development` 后追加 `--fresh-ai`。用同一组 Git SHA 和 `--fresh-ai --profile host` 准备后台源码。API 运行包保存两个来源、编译证明、公共 AI 数据包和四阶段原 SQL：公共 14、Rental 2、公共 AI 1、Rental 扩展 1。

使用专用空库，按包内说明生成两份 Client、应用锁定的 18 条迁移并初始化 SaaS。设置 `RENTAL_AI_MODE=enabled`，`RENTAL_DEPLOYMENT_LOCK` 指向完整 v2 锁，`RENTAL_PUBLIC_AI_DATA_PACKAGE_DIR` 指向同包的 `public-ai-data`。先执行 [品类初始化](src/ai-fresh-initialize.ts)，再运行 [新装入口](src/ai-fresh-main.ts)。后台使用同一部署锁、数据包及已核标准 Rental 包，执行 `build:fresh`。旧库继续使用原 SQL、原锁与原账，不能直接重跑新装材料。

当前新装扩展为 [20261127000000](prisma/ai-extension/20261127000000-initial.sql)。它只修正 MySQL 对中间 `CHECK` 布尔类型的要求，末态约束与原方案相同；前版 [原 SQL](prisma/ai-extension/20261126000000-initial.sql) 及其 [来源](prisma/ai-extension/provenance.json)保留，不作为可执行的新装文件。

### v2 安装观察接点

`@rental-os/rental-api/ai-app-module` 导出 [FreshRentalAiSelection](src/ai-fresh-selection.ts)。`lock` 返回完整 v2 锁的副本；`inspect(transaction)` 每次核实际 Rental/能力包，并复用原 `phasedData` 的迁移顺序、摘要和物理检查，返回 `CoreDataObservation | null` 及后置扩展的原收据、`CoreMigrationExecution | null`、`CorePhysicalDataObservation | null`。缺账、冲突、未完成和读取失败使用固定原因码，不返回原数据库错误，也不推断允许重跑。`data().phasedData` 仍只在整条原门禁通过时返回准入观察。

同一出口的 [readFreshRentalClientObservation](src/ai-installation-observation.ts) 与启动入口共用所选 schema 及实际加载 Client 模型检查；`readFreshRentalInitialization(database, transaction)` 只读原 SaaS 初始化状态/收据和 Rental 内置品类对象。调用者须使用同一数据库、原身份围栏和一致读取事务，分别报告 Client、包、原账、物理、初始化证据；这些事实不代表服务已运行、部署准入或成员业务授权。

显式 fresh、非 legacy 的 AI 宿主挂载 `GET /api/platform/core-installation/status`，不接受查询参数，响应禁止缓存。合同复用 `@rental-os/core-contracts/phased-installation`；当前 operator/SaaS 身份和 `system:tenant:manage` 权限由原 Guard 与同一 RepeatableRead 事务前后复核。实际包、Client、原账、物理结构和初始化分别报告；读取失败返回固定原因码及 null/not_checked，不执行初始化或迁移。

公共运行身份沿包管理原配置 `CORE_PACKAGE_STORAGE_ROOT` 和 `CORE_PLATFORM_PACKAGE_REFERENCE` 读取受管归档索引。索引须指向同一完整锁的底座归档；底座六包入口、原 `rental-host.context.json`、准备回执与完整 v2 部署锁必须相符。缺归档或运行依据时标记 `runtime_identity_unverified`，不能把锁声明当实际运行结果。普通无 AI 与 legacy 宿主不挂载此路由，v1 包管理继续拒绝完整 v2 组合。

本候选使用包含完整 v2 读口与 SDK 同源映射修复的固定 Zelo `5a6bbbf7593414a122a060018cb1abd87f1c20bf`。开发组合不具备正式发版或服务器迁移许可。

## 显式选装 MCP（仅新装开发）

在同一打包命令上使用 `--development --fresh-ai --mcp`。配套源码也要使用同一组 SHA 和 `--fresh-ai --mcp --profile host`。只对 `utf8mb4_unicode_ci` 的专用空库应用 **14 公共 → 2 Rental → 1 公共 AI → 5 MCP → 1 Rental 扩展**。沿包内步骤设置 `RENTAL_MCP_DATA_PACKAGE_DIR`，指向实际随包的 `packages/mcp-server` 绝对目录；再用 `dist-mcp/mcp-fresh-initialize.js` 初始化，启动 `dist-mcp/mcp-fresh-main.js`。原 18 条 AI-only、普通库和旧混合库不能换锁直接采用这条链。

该开发启动叶只核验 MCP 原账与物理结构，默认不挂 MCP HTTP。需对外接入时，第一方源码显式调用 [bootstrapFreshRentalMcp(sources)](src/mcp-bootstrap.ts)。`SelectedRentalMcpSources` 由原权威供给：AS 当前元数据，目录真实发布、输出字段投影和分类计量，及需启用的原验证来源。可选报价只在取得原对象 Guard、同事务历史读者、原键目标和外发策略后登记。Web 登录、通用目录与数据库表存在本身都不会开放这些能力。[同实例装配](src/mcp-host.ts)

- [启动](src/main.ts) → [宿主装配](src/app.module.ts) → [同实例应用](src/assembly.ts)与[所选数据访问](src/database.ts)
- [实际 HTTP 策略](src/http-policy.ts)、[兼容路径和 OpenAPI](src/openapi.ts)
- [部署材料准备](src/prepare-deployment.ts)只产出待部署材料，不连接、迁移或改写原账；[公开包工厂接点](src/package.ts)复用领域包的实际文档与构建材料。

旧组合和已发布版本继续使用各自固定来源。本目录不是独立安装目录，构建和运行命令统一在准备后的组合中执行。

## 旧 mixed 库的显式过渡

旧库不使用新装18/23条的执行目录。受控宿主从正式 `@rental-os/rental-api/app-module` 或 `/ai-app-module` 导出的 [LegacyRentalDataSelection](src/legacy-data-selection.ts) 选择旧账模式，传入完整固定部署锁和底座源码归档原字节；归档SHA须等于该锁。所选Core仍由原安装包读取器核清单、来源和摘要。普通、新装与MCP默认入口不改变；旧库模式当前只支持单Rental及可选AI，MCP必须另有旧账/结构映射，不能借23条空库链启用。

[七表预检](src/legacy-public-upgrade.ts)读取完整原Prisma账和物理目录。260成功＋1指定恢复回滚只返回 `requires_original_three`，须先另获批准执行原三份历史增量；到263成功＋1原回滚且七表不存在才返回 `ready_for_seven_tables`。`selection.publicUpgrade().files()`给出原公共Core访问、绑定、限流三份SQL及MySQL锁文件；它们只有七表CREATE，不包含完整public initial。追加后必须有三条原名/原摘要成功账并通过七表字段/索引/CHECK检查；部分DDL、缺账、未完成账或摘要变化均拒绝继续。该方法不执行SQL、不写或resolve原账。

运行通过 `RentalAppModule.register({lock,aiMode:"disabled",legacy:selection})`；已选AI时沿原 `createRentalAiHostModule({lock,fresh:materials,legacy:selection,...})`，其中 `fresh`只提供已核新版本材料和物理计划，运行时明确使用legacy原账读取器，不能调用新装initialize。AI还须由同一正式数据/扩展材料的 `createRentalAiMysqlPlans`供给 `additionalPhysical:[{owner:"rental-ai-extension",read:plans.extension.readPhysical}]`。每次准入检查旧完整账、追加账及公共/Rental/所选AI/扩展实际物理合同，保留旧表与原账；不生成新装appliedMigrations。物理合同不等价时报告具体owner并停止，不能把七表完成视为整个组合已可运行。

[可信管理应用](src/legacy-access-management.ts)由[同一宿主](src/assembly.ts)构造，[管理HTTP](src/legacy-access-http.ts)仅在显式旧库模块挂载。所有路由为POST，根前缀 `/api/platform/rental-legacy/`，文档来自同一登记表。当前operator签名、原会话及租户管理权限必须有效：

| 操作 | 路径 | 原身份与输入 |
| --- | --- | --- |
| 准备租户授权 | tenant/prepare | SaaS与system:tenant:manage；tenantId |
| 准备成员/绑定 | members/prepare | 当前租户管理员或all范围且system:user:manage；空对象 |
| 补缺租户授权 | tenant/adopt | 同SaaS；confirmed、operationId、expectedRevision |
| 补缺成员分配 | members/adopt | 同租户管理；加userId |
| 建立原范围绑定 | bindings/adopt | 同租户管理；可选原workspaceId |
| 读原授权收据 | tenant/operation | 同SaaS；tenantId、原operationId |
| 读原成员收据 | members/operation | 同租户管理；userId、原operationId |
| 读原绑定收据 | bindings/operation | 同租户管理；可选workspaceId、原operationId |

`confirmed`由最近一次准备结果取 `tenantId/sourceFingerprint/coreFingerprint`。按租户授权→重新准备→逐成员分配→重新准备→逐范围绑定处理；每次调用均使用原expectedRevision和独立稳定operationId。原disabled/revoked记录保留，原角色、组织、地点和空间数据不重建，现有行业initializer不运行。失应答只查原operationId；不存在收据不证明可换键重做。

上线审批须固定双SHA/包摘要/完整锁、当次一致备份及恢复证明，再依次批准原三DDL、七表追加、只读桥接观察、单项授权映射及同锁API/Web切换。本工具不授权这些线上动作。旧镜像回退必须先核它能读取升级后的库且停止所有新旧写方；不删除新表或新收据来伪装回退，数据库恢复另走经验证的备份恢复。未完成的原unknown继续按原键调查，不因切换重发。
