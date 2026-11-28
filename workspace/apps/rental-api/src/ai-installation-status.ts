/** 完整 v2 安装事实在原 SaaS 会话锁内一致读取。包/Client 前后复核；
 * 仅观察原准备、迁移、物理及初始化，不调用初始化器或 v1 候选执行器。 */
import { ForbiddenException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import { coreRegisteredSummary, type CoreDeploymentLock } from "@rental-os/core-contracts";
import { CorePhasedInstallationObservationSchema, PHASED_INSTALLATION_HTTP,
  type CorePhasedInstallationObservation } from "@rental-os/core-contracts/phased-installation";
import { PlatformPrincipalAuthority } from "@rental-os/platform-server/principal";
import { hasEffectivePermission } from "@rental-os/platform-server/permission-match";
import type { CoreDeployedCatalogue } from "@rental-os/core-host";
import type { RentalApplication } from "@rental-os/rental-core/application";
import type { RentalDatabaseClient, RentalDatabaseTransaction } from "./database";
import type { RentalInstallationStatus } from "./installation-http";
import type { FreshRentalAiSelection } from "./ai-fresh-selection";
import { readFreshRentalClientObservation, readFreshRentalExtensionObservation,
  readFreshRentalInitialization, readFreshRentalPreparation } from "./ai-installation-observation";

type Observed = Extract<CorePhasedInstallationObservation, { status: "observed" }>;
type Issue = Observed["issues"][number];
const unchecked = () => ({ state: "not_checked" as const, receipt: "not_checked" as const });
const safe = async <T>(read: () => Promise<T> | T): Promise<T | null> => { try { return await read(); } catch { return null; } };
export function createFreshRentalInstallationStatus(input: {
  database: RentalDatabaseClient;
  authentication: RentalApplication["authSource"];
  catalogue: CoreDeployedCatalogue;
  fresh: FreshRentalAiSelection;
  /** 由同一静态宿主绑定公共完整 v2 运行证据读取器；不能消费请求中的发行或目录。 */
  readPlatform(): Promise<CoreDeploymentLock["platform"] | null>;
}): RentalInstallationStatus {
  const principals = new PlatformPrincipalAuthority<RentalDatabaseTransaction>(input.authentication);
  const permitted = (user: Awaited<ReturnType<RentalApplication["authSource"]["findUserById"]>>) =>
    user?.isSaasAdmin === true && hasEffectivePermission(user.permissions, "system:tenant:manage");
  const materials = async () => ({ installed: input.fresh.readInstalled(),
    platform: await safe(input.readPlatform), preparation: await safe(() => readFreshRentalPreparation(input.fresh.lock)),
    extension: await safe(() => readFreshRentalExtensionObservation(input.fresh.lock)),
    client: await safe(() => readFreshRentalClientObservation(input.fresh.schema)) });
  return { async read() {
    const actor = principals.current();
    return input.database.$transaction(async transaction => {
      const lease = await principals.lock(transaction, actor, actor.tenantId, undefined, false);
      if (!permitted(lease.user)) throw new ForbiddenException("缺少当前 SaaS 安装观察权限");
      const before = await materials(), lock = input.fresh.lock;
      const result: Observed = { format: PHASED_INSTALLATION_HTTP.format, status: "observed", observedAt: new Date().toISOString(), lock,
        preparation: before.preparation ? { status: "prepared", deployment: "pending" } : null,
        installed: before.installed.installed ? { platform: before.platform, ...before.installed.installed,
          postCapability: before.extension ? lock.postCapability : [] } : null,
        registered: before.installed.installed ? [...input.catalogue.registrations.values()].map(item => coreRegisteredSummary(item.manifest)) : [],
        runtimeClient: before.client ? { schemaSha256: before.client.schemaSha256 } : null,
        database: { base: null, postCapability: [] }, initialization: { platform: unchecked(), cores: [{ coreId: "rental", ...unchecked() }] }, issues: [] };
      const add = (scope: Issue["scope"], code: string) => { if (!result.issues.some(item => item.scope === scope && item.code === code)) result.issues.push({ scope, code }); };
      if (!result.installed || !before.extension || !before.preparation) add("materials", "materials_unavailable");
      if (!before.platform || !before.client) add("materials", "runtime_identity_unverified");
      const inspected = await input.fresh.inspect(transaction), data = inspected.observation;
      if (!isDeepStrictEqual(inspected.installed, before.installed.installed)) add("materials", "deployment_changed");
      result.database = { base: data.data, postCapability: data.postCapability.map(item => ({ coreId: item.coreId,
        migrationId: item.migration.id, appliedMigration: item.execution?.state === "ready" && item.receipt
          ? { id: item.migration.id, sha256: item.receipt.checksum } : null, execution: item.execution, physical: item.physical })) };
      if (!data.data) add("database", data.reason === "ledger_invalid" || data.reason === "ledger_conflict" ? "ledger_mismatch"
        : data.reason === "verified" || data.reason === "not_checked" ? "observation_unavailable" : data.reason);
      if (data.data) {
        const initialization = await safe(() => readFreshRentalInitialization(input.database, transaction));
        if (initialization) {
          result.initialization.platform = { ...initialization.platform, receipt: initialization.platform.receipt ?? "not_found" };
          result.initialization.cores = initialization.cores.map(item => ({ coreId: item.coreId, state: item.state, receipt: item.receipt }));
          const states = [result.initialization.platform, ...result.initialization.cores];
          if (states.some(item => item.state === "conflict")) add("initialization", "initialization_conflict");
          if (states.some(item => item.state === "uninitialized")) add("initialization", "initialization_required");
        } else add("initialization", "initialization_unchecked");
      } else add("initialization", "initialization_unchecked");
      const after = await materials();
      if (!permitted(await lease.revalidate())) throw new ForbiddenException("安装观察期间 SaaS 权限变化");
      if (!isDeepStrictEqual(before, after) || result.issues.some(item => item.code === "deployment_changed"))
        return CorePhasedInstallationObservationSchema.parse({ format: PHASED_INSTALLATION_HTTP.format, status: "unavailable",
          observedAt: new Date().toISOString(), issues: [{ scope: "materials", code: "deployment_changed" }] });
      return CorePhasedInstallationObservationSchema.parse(result);
    }, { isolationLevel: "RepeatableRead", timeout: 30_000 });
  } };
}
