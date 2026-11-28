/** 明确启用 AI 的 Rental 装配入口。实际完整数据包、原迁移账与物理观察分别核定；
 * 不在无 AI 入口导入原 Runtime，不生成 Client、连接数据库或启动生命周期。 */
import { dirname, resolve } from "node:path";
import type { ConfigService } from "@nestjs/config";
import type { CoreDeploymentLock } from "@rental-os/core-contracts";
import { requireAiNativeDataPackage } from "@rental-os/ai-native-data/data-package";
import { createAiNativeMysqlDataPlanFromContribution } from "@rental-os/ai-native-data/mysql-data";
import { createRentalAiParticipants, requireRentalAiSelection, type RentalAiBinding } from "./ai-composition";
import { composeRentalApplication, type RentalHostAssembly } from "./assembly";
import type { RentalHostCoreSetup } from "./additional-cores";
import { createRentalAiFileCleanupSource } from "./ai-file-cleanup-source";
import type { RentalDatabaseClient } from "./database";
import { createRentalAiHttpPolicy, rentalAiDeploymentContinuationSelector, rentalAiOriginalReceiptSelector,
  rentalAiPlatformManagementSelector } from "./ai-http-policy";
import { createRentalAiRemovalDependencies } from "./core-removal-source";
import { FreshRentalAiSelection } from "./ai-fresh-selection";
import type { LegacyRentalDataSelection } from "./legacy-data-selection";
import { createFreshRentalInstallationStatus } from "./ai-installation-status";
import { readFreshRentalPlatformObservation } from "./ai-installation-observation";

export function composeRentalAiApplication<Additional = unknown>(input: {
  database: RentalDatabaseClient;
  configuration: ConfigService;
  lock: CoreDeploymentLock;
  fresh?: FreshRentalAiSelection;
  legacy?: LegacyRentalDataSelection;
  /** 静态宿主提供；由原装配逐项核定固定包、数据计划与 HTTP，不授予 AI 权限。 */
  additionalCores?: readonly RentalHostCoreSetup<Additional>[];
}): RentalHostAssembly<RentalAiBinding, Additional> {
  const fresh = input.fresh instanceof FreshRentalAiSelection ? input.fresh : undefined;
  if (fresh && input.additionalCores?.length) throw new Error("新装 AI 所选锁只支持单 Rental");
  const lock = fresh ? fresh.select(input.lock) : requireRentalAiSelection(input.lock);
  const data = fresh?.data() ?? (() => {
    const root = resolve(dirname(require.resolve("@rental-os/ai-native-data/data-package")), "..");
    const installed = requireAiNativeDataPackage(root, lock.dataCapabilities![0]);
    return { dataPlan: createAiNativeMysqlDataPlanFromContribution(installed.contribution),
      readDataPackages: () => [requireAiNativeDataPackage(root, lock.dataCapabilities![0])] };
  })();
  const participants = createRentalAiParticipants({ ...input, lock });
  const policy = createRentalAiHttpPolicy();
  const continuation = rentalAiDeploymentContinuationSelector(policy), receipts = rentalAiOriginalReceiptSelector(policy);
  const management = rentalAiPlatformManagementSelector(policy);
  return composeRentalApplication<RentalAiBinding, Additional>({ ...input, lock, aiMode: "enabled", ai: { ...participants, ...data,
    ...(fresh && !input.legacy ? { installation: (host: Pick<Parameters<typeof createFreshRentalInstallationStatus>[0],
      "database" | "authentication" | "catalogue">) =>
      createFreshRentalInstallationStatus({ ...host, fresh,
        readPlatform: () => readFreshRentalPlatformObservation(input.configuration, fresh.lock) }) } : {}),
    deploymentContinuation: (method, path) => continuation.isRoute({ method, url: path }),
    originalReceiptRead: (method, path) => receipts.isRoute({ method, url: path }),
    platformManagement: (method, path) => management.isRoute({ method, url: path }),
    removalDependencies: createRentalAiRemovalDependencies(input.database),
    fileCleanupKnowledge: createRentalAiFileCleanupSource() } });
}

export type RentalAiHostAssembly<Additional = unknown> = RentalHostAssembly<RentalAiBinding, Additional>;
