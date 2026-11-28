/** Rental-owned AI tables and relationship extensions for one host Client.
 * Fixed public AI and Rental inputs are mandatory. SQL execution ordering stays
 * with the deployment host; this module does not manufacture migration receipts. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sqltag as sql } from "@prisma/client/runtime/library";
import { CoreDataObservationSchema, CorePhysicalDataObservationSchema, CoreSourceSchema, checkCoreCombination, checkPlatformDataCapabilities,
  coreDeploymentHostVersions, isCoreVersionSupported, type CoreDataObservation, type CoreManifest, type CorePlatformDataCapabilityRelease,
  type CoreMigrationExecution, type CorePhysicalDataObservation } from "@rental-os/core-contracts";
import { CorePhasedMigrationLockSchema, corePostCapabilityPrismaMigrationName, platformCapabilityPrismaMigrationName,
  corePrismaMigrationName } from "@rental-os/core-contracts/deployment";
import { CoreAccessError } from "@rental-os/core-host";
import type { CoreMysqlDataPlan } from "@rental-os/core-host/mysql-deployment";
import type { CoreHostSqlTransaction } from "@rental-os/core-host/mysql";
import { composeCorePrismaSchema, type CorePrismaContribution } from "@rental-os/core-contracts/prisma";
import { mysqlForeignKeyExtension, mysqlMigrationStatements, mysqlStructureFromMigrations,
  type MysqlForeignKeyExtension } from "@rental-os/platform-core-host/mysql-structure";
import { readMysqlPhysicalData } from "@rental-os/platform-core-host/mysql-physical";
import { RENTAL_PRISMA_PUBLIC_RELATIONS } from "@rental-os/rental-core/prisma-schema";
import { composePublicAiPrismaSchema, PUBLIC_AI_DATA_VERSION, type PublicAiDataContribution } from "@rental-os/public-ai-data/public-data";
import { readPublicAiDataPackage } from "@rental-os/public-ai-data/public-data-package";
import { createPublicAiMysqlDataPlan } from "@rental-os/public-ai-data/public-mysql-data";

export const RENTAL_AI_EXTENSION_FILES = [
  {
    "file": "prisma/ai-extension/schema.prisma",
    "sha256": "8f22ea1360c7a58752505b511d83936b225465d20836690d38f35e8020b1fcb3"
  },
  {
    "file": "prisma/ai-extension/20261127000000-initial.sql",
    "sha256": "11954e36e6553b70d8613d5b4f00f44f7a2bb3abbf16b758919a331e87e4d86b"
  },
  {
    "file": "prisma/ai-extension/20261127000000-provenance.json",
    "sha256": "618895a8c8bc99d7c03ca3dd86f4fc0fd609eab2d143b0dd03450070e149e24e"
  }
] as const;
export const RENTAL_AI_EXTENSION_MIGRATION = { id: "rental.20261127000000-ai-extension", ...RENTAL_AI_EXTENSION_FILES[1] } as const;
export const RENTAL_AI_EXTENSION_PREREQUISITES = {
  publicAi: { minInclusive: PUBLIC_AI_DATA_VERSION, maxExclusive: "0.2.1" },
  rental: { minInclusive: "0.1.0", maxExclusive: "0.1.2",
    initial: { id: "rental.20261119030000-initial", sha256: "59e69aadf4db0138561ec9233955941da32a2f27f576583bd7915b9f1a7d05ae" } }
} as const;
/** Version selects the release precondition, never a rewrite of the data version or SQL. */
export function rentalAiExtensionPrerequisites(release: CorePlatformDataCapabilityRelease) {
  if (release.id !== "ai-native" || release.data.version !== PUBLIC_AI_DATA_VERSION)
    throw new Error("Rental AI 扩展缺少已核的公共数据版本");
  if (release.version === "0.2.0") return RENTAL_AI_EXTENSION_PREREQUISITES;
  if (release.version === "0.2.2") return { ...RENTAL_AI_EXTENSION_PREREQUISITES,
    publicAi: { minInclusive: "0.2.2", maxExclusive: "0.2.3" } } as const;
  if (release.version === "0.2.4") return { ...RENTAL_AI_EXTENSION_PREREQUISITES,
    publicAi: { minInclusive: "0.2.4", maxExclusive: "0.2.5" } } as const;
  throw new Error("Rental AI 扩展不支持该公共数据发行");
}

const rentalRelations = {
  "BusinessWorkspace": [
    "aiInspectionDrafts                AiInspectionDraft[]",
    "aiBusinessFailureEvents           AiBusinessFailureOutbox[]",
    "aiAutomationSubjects              AiAutomationSubject[]",
    "aiKnowledgePolicyAuthorities      AiKnowledgePolicyManagementAuthority[]",
    "aiClientSceneMaterials            AiClientSceneMaterial[]",
    "aiClientTaskPolicies              AiClientTaskPolicy[]",
    "aiInspectionEvidenceBindings      AiInspectionEvidenceBinding[]",
    "aiScopes                          AiScope[]"
  ],
  "RentalCoreStateSnapshot": [
    "aiFailureConfigurationEvents AiBusinessFailureOutbox[] @relation(\"AiFailureConfigurationSnapshot\")"
  ],
  "TenantRentalProfile": [
    "aiFailureConfigurationEvents AiBusinessFailureOutbox[] @relation(\"AiFailureConfigurationProfile\")"
  ],
  "RentalFulfillmentLocation": [
    "aiFailureLocationEvents AiBusinessFailureOutbox[] @relation(\"AiFailureLocation\")"
  ],
  "RentalOrder": [
    "aiFailureFulfillmentEvents AiBusinessFailureOutbox[] @relation(\"AiFailureFulfillment\")"
  ],
  "RentalPaymentRefund": [
    "aiFailureEvents  AiBusinessFailureOutbox[] @relation(\"AiFailureRefund\")"
  ],
  "RentalInspectionRecord": [
    "failureEvents     AiBusinessFailureOutbox[] @relation(\"AiFailureInspection\")"
  ],
  "RentalTenantBusinessSettings": [
    "aiFailureConfigurationEvents AiBusinessFailureOutbox[] @relation(\"AiFailureConfigurationSettings\")"
  ],
  "RentalNotificationLog": [
    "aiFailureEvents      AiBusinessFailureOutbox[]  @relation(\"AiFailureNotification\")"
  ]
} as const;
const publicRelations = {
  "AiClientSceneMaterial": [
    "workspace       BusinessWorkspace @relation(fields: [tenantId, workspaceId], references: [tenantId, id], onDelete: Restrict, onUpdate: Restrict, map: \"ai_client_materials_workspace_fk\")",
    "bookingDrafts   AiClientBookingDraft[]"
  ],
  "AiClientTaskPolicy": [
    "workspace    BusinessWorkspace @relation(fields: [tenantId, workspaceId], references: [tenantId, id], onDelete: Restrict, onUpdate: Restrict, map: \"ai_client_task_policy_workspace_fk\")"
  ],
  "AiAutomationSubject": [
    "workspace             BusinessWorkspace @relation(fields: [tenantId, workspaceId], references: [tenantId, id], onDelete: Restrict, onUpdate: Restrict, map: \"ai_automation_subject_workspace_fk\")"
  ],
  "AiAutomationInput": [
    "event                 AiBusinessFailureOutbox @relation(fields: [tenantId, workspaceId, eventId], references: [tenantId, workspaceId, id], onDelete: Restrict, onUpdate: Restrict, map: \"ai_automation_input_event_fk\")"
  ],
  "AiKnowledgePolicyManagementAuthority": [
    "workspace           BusinessWorkspace @relation(fields: [tenantId, workspaceId], references: [tenantId, id], onDelete: Restrict, onUpdate: Restrict, map: \"ai_kp_authority_workspace_fk\")"
  ],
  "AiTaskOriginalRequest": [
    "quoteSelections          AiTaskQuoteSelection[]"
  ],
  "AiScope": [
    "workspace   BusinessWorkspace? @relation(fields: [tenantId, workspaceId], references: [tenantId, id], onDelete: Restrict, onUpdate: Restrict)"
  ],
  "AiRun": [
    "quoteSelections    AiTaskQuoteSelection[]",
    "reprepareTargets   AiApprovalReprepare[]"
  ],
  "AiStep": [
    "reprepareTargets    AiApprovalReprepare[]"
  ],
  "AiProposalVersion": [
    "originalReprepares AiApprovalReprepare[] @relation(\"AiReprepareOriginal\")",
    "replacementReprepares AiApprovalReprepare[] @relation(\"AiReprepareReplacement\")"
  ],
  "AiProposalAction": [
    "snapshots          AiApprovedOrderSnapshot[]",
    "reprepares         AiApprovalReprepare[]"
  ],
  "FileAsset": [
    "aiInspectionBindings AiInspectionEvidenceBinding[]"
  ]
} as const;
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface RentalAiDataExtension {
  readonly owner: "rental";
  readonly schema: string;
  readonly sql: string;
}

export function readRentalAiDataExtension(files: ReadonlyMap<string, Uint8Array>): RentalAiDataExtension {
  const content = new Map<string, string>();
  for (const asset of RENTAL_AI_EXTENSION_FILES) {
    const bytes = files.get(asset.file);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 32 * 1024 * 1024 || hash(bytes) !== asset.sha256)
      throw new Error("Rental AI 固定扩展材料缺失或变化");
    content.set(asset.file, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  }
  for (const file of files.keys()) if (file.startsWith("prisma/ai-extension/") && !content.has(file))
    throw new Error("Rental AI 扩展包含未登记材料");
  return Object.freeze({ owner: "rental", schema: content.get(RENTAL_AI_EXTENSION_FILES[0].file)!,
    sql: content.get(RENTAL_AI_EXTENSION_FILES[1].file)! });
}

function assertRentalAiDataExtension(extension: RentalAiDataExtension): void {
  if (extension.owner !== "rental" || hash(extension.schema) !== RENTAL_AI_EXTENSION_FILES[0].sha256
    || hash(extension.sql) !== RENTAL_AI_EXTENSION_MIGRATION.sha256)
    throw new Error("Rental AI 扩展材料已变化");
}

/** The generic composer requires relation targets in this same contribution.
 * Bundle Rental's own models with its AI extension before adding back-references. */
export function createRentalAiPrismaContribution(rentalSchema: string, extension: RentalAiDataExtension): CorePrismaContribution {
  assertRentalAiDataExtension(extension);
  if (hash(rentalSchema) !== "08dd7ecebeb5cc1f4a389ee13e062501e89cd7e5ef86bb821e9d58eaf050f7b1")
    throw new Error("Rental AI 组合的原 Rental schema 已变化");
  let schema = rentalSchema;
  for (const [name, fields] of Object.entries(rentalRelations)) {
    const block = [...schema.matchAll(/^model (\w+) \{[\s\S]*?^\}/gm)].find(match => match[1] === name);
    if (!block) throw new Error("Rental AI 关系缺少原业务模型");
    const existing = new Set(block[0].split(/\r?\n/).flatMap(line => /^\s*(\w+)\s+\w/.exec(line)?.[1] ?? []));
    if (fields.some(field => existing.has(field.split(/\s/)[0]))) throw new Error("Rental AI 关系已存在");
    schema = schema.replace(block[0], block[0].slice(0, -1) + fields.map(field => "  " + field).join("\n") + "\n}");
  }
  const relations: Record<string, readonly string[]> = { ...RENTAL_PRISMA_PUBLIC_RELATIONS };
  for (const [name, fields] of Object.entries(publicRelations)) relations[name] = [...(relations[name] ?? []), ...fields];
  return { id: "rental", schema: schema + "\n" + extension.schema, publicRelations: relations };
}

export function composeRentalPublicAiPrismaSchema(base: string, ai: PublicAiDataContribution,
  rentalSchema: string, extension: RentalAiDataExtension): string {
  return composeCorePrismaSchema(composePublicAiPrismaSchema(base, ai), [createRentalAiPrismaContribution(rentalSchema, extension)]);
}

/** Observe the public tables with their selected keys and the Rental-owned
 * tables separately. Registration of the extension's receipt needs the host's
 * ordered deployment contract; physical evidence alone cannot mark it applied. */
export function createRentalAiMysqlPlans(ai: PublicAiDataContribution, extension: RentalAiDataExtension, release?: CorePlatformDataCapabilityRelease) {
  assertRentalAiDataExtension(extension);
  const created = new Set<string>(), own: string[] = [], keys: MysqlForeignKeyExtension[] = [];
  for (const sql of mysqlMigrationStatements(extension.sql)) {
    const create = /^CREATE TABLE `([^`]+)`/iu.exec(sql);
    if (create) created.add(create[1]);
    const alter = /^ALTER TABLE `([^`]+)`/iu.exec(sql);
    if (alter && !created.has(alter[1])) keys.push(mysqlForeignKeyExtension(sql));
    else own.push(sql);
  }
  const expected = mysqlStructureFromMigrations([own.join(";\n") + ";"]);
  return {
    publicAi: createPublicAiMysqlDataPlan(ai, keys),
    extension: {
      installation: "fresh-public" as const, owner: extension.owner, migration: { ...RENTAL_AI_EXTENSION_MIGRATION },
      prerequisites: structuredClone(release ? rentalAiExtensionPrerequisites(release) : RENTAL_AI_EXTENSION_PREREQUISITES), sql: extension.sql,
      readPhysical: (database: Pick<CoreHostSqlTransaction, "$queryRaw">) => readMysqlPhysicalData(database, expected, PUBLIC_AI_DATA_VERSION)
    }
  };
}

type OriginalMigrationReceipt = { migrationName: string; checksum: string; finishedAt: Date | null; rolledBackAt: Date | null;
  startedAt?: Date; appliedSteps?: number | bigint };
const validDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
type ObservationPlan = { version: string; read: CoreMysqlDataPlan["readPhysical"] };

export type FreshRentalAiDataReason = "not_checked" | "verified" | "ledger_unavailable" | "ledger_invalid"
  | "ledger_conflict" | "ledger_incomplete" | "physical_unavailable" | "physical_mismatch";
/** 原准入与诊断共用一次读取。null 表示没有取得证据，不能据缺账推断可重跑。 */
export interface FreshRentalAiDataInspection {
  data: CoreDataObservation | null;
  reason: FreshRentalAiDataReason;
  physical: Array<{ owner: string; observation: CorePhysicalDataObservation | null }>;
  postCapability: Array<{
    coreId: string;
    migration: { id: string; sha256: string };
    migrationName: string;
    receipt: { checksum: string; finishedAt: string | null; rolledBackAt: string | null } | null;
    execution: CoreMigrationExecution | null;
    physical: CorePhysicalDataObservation | null;
  }>;
}
type FreshRentalAiDataReader = ((database: Pick<CoreHostSqlTransaction, "$queryRaw">) => Promise<CoreDataObservation>) & {
  inspect(database: Pick<CoreHostSqlTransaction, "$queryRaw">): Promise<FreshRentalAiDataInspection>;
};

/** Data gate for the selected fresh installation. The caller supplies plans and
 * extension provenance from its fixed build and reuses its current SQL reader. */
export function createFreshRentalAiDataObservation(input: {
  lock: unknown;
  platform: CoreMysqlDataPlan;
  rental: CoreMysqlDataPlan;
  publicAiFiles: ReadonlyMap<string, Uint8Array>;
  extension: { source: CoreManifest["source"]; files: ReadonlyMap<string, Uint8Array> };
  mcp?: CoreMysqlDataPlan;
}): FreshRentalAiDataReader {
  const { base, postCapability } = CorePhasedMigrationLockSchema.parse(input.lock);
  const [pin] = base.cores, releases = base.dataCapabilities ?? [], [post] = postCapability;
  const release = releases.find(item => item.id === "ai-native"), mcp = releases.find(item => item.id === "mcp");
  if (base.cores.length !== 1 || pin.manifest.id !== "rental" || releases.length !== (input.mcp ? 2 : 1)
    || !release || Boolean(mcp) !== Boolean(input.mcp) || postCapability.length !== 1 || post.coreId !== "rental"
    || checkPlatformDataCapabilities(base).length
    || checkCoreCombination([pin.manifest], coreDeploymentHostVersions(base)).issues.length)
    throw new Error("Rental 新装锁与所选 Rental、公共 AI、MCP 或后置扩展不一致");
  if (input.mcp && (!mcp || !isDeepStrictEqual(mcp.source, base.platform.source)
    || !isDeepStrictEqual(input.mcp.data, mcp.data) || !isDeepStrictEqual(input.mcp.migrationNames,
      mcp.data.migrations.map(item => platformCapabilityPrismaMigrationName(mcp.id, item.id)))))
    throw new Error("新装 MCP 数据计划与锁内原材料不一致");

  const { contribution } = readPublicAiDataPackage(input.publicAiFiles, release);
  const [publicMigration] = contribution.data.migrations;
  const { publicAi, rental } = rentalAiExtensionPrerequisites(release);
  const { initial, ...rentalVersion } = rental;
  const extensionSource = CoreSourceSchema.parse(input.extension.source);
  if (!isDeepStrictEqual(post.migration, { ...RENTAL_AI_EXTENSION_MIGRATION, source: extensionSource })
    || !isDeepStrictEqual(post.prerequisites, { core: { version: rentalVersion, migration: initial },
      capability: { id: release.id, version: publicAi, migration: { id: publicMigration.id, sha256: publicMigration.sha256 } } })
    || !isCoreVersionSupported(pin.manifest.data.version, rentalVersion)
    || !pin.manifest.data.migrations.some(item => item.id === initial.id && item.sha256 === initial.sha256))
    throw new Error("Rental AI 新装扩展的固定来源、原迁移或数据前置不一致");
  const platformNames = base.platform.data.migrations.map(item => /^prisma\/migrations\/([^/]+)\/migration\.sql$/u.exec(item.file)?.[1]);
  const rentalNames = pin.manifest.data.migrations.map(item => corePrismaMigrationName("rental", item.id));
  if (!isDeepStrictEqual(base.platform.data, input.platform.data) || !isDeepStrictEqual(pin.manifest.data, input.rental.data)
    || platformNames.some(name => !name) || !isDeepStrictEqual(input.platform.migrationNames, platformNames)
    || !isDeepStrictEqual(input.rental.migrationNames, rentalNames))
    throw new Error("Rental AI 新装原账计划与固定底座或 Rental 不一致");

  const ai = createRentalAiMysqlPlans(contribution, readRentalAiDataExtension(input.extension.files), release);
  const capabilityPlans = [{ capabilityId: release.id, plan: ai.publicAi },
    ...(mcp && input.mcp ? [{ capabilityId: mcp.id, plan: input.mcp }] : [])];
  const basePlans = [input.platform, input.rental, ...capabilityPlans.map(item => item.plan)];
  const migrationName = corePostCapabilityPrismaMigrationName(post.coreId, post.migration.id);
  const expected = [...basePlans.flatMap(plan => plan.data.migrations.map((item, index) => ({
    name: plan.migrationNames[index], checksum: item.sha256
  }))), { name: migrationName, checksum: post.migration.sha256 }];
  const checksums = new Map(expected.map(item => [item.name, item.checksum]));
  if (checksums.size !== expected.length) throw new Error("Rental AI 新装原迁移名称冲突");

  const physical: ObservationPlan[] = [...basePlans.map(plan => ({ version: plan.data.version, read: plan.readPhysical.bind(plan) })),
    { version: PUBLIC_AI_DATA_VERSION, read: ai.extension.readPhysical }];
  const unavailable = () => new CoreAccessError("core_unavailable", "Rental AI 新装的原迁移账或物理结构尚未核定");
  const inspect = async (database: Pick<CoreHostSqlTransaction, "$queryRaw">): Promise<FreshRentalAiDataInspection> => {
    const owners = ["platform", "rental", ...capabilityPlans.map(item => item.capabilityId), "rental-ai-extension"];
    const result: FreshRentalAiDataInspection = { data: null, reason: "ledger_unavailable",
      physical: owners.map(owner => ({ owner, observation: null })), postCapability: [{
      coreId: post.coreId, migration: { id: post.migration.id, sha256: post.migration.sha256 }, migrationName,
      receipt: null, execution: null, physical: null
    }] };
    const extension = result.postCapability[0];
    try {
      // Preserve the database order across phases. A v1, extra or mixed receipt
      // cannot be projected away to make this fresh installation look complete.
      const receipts = mcp ? await database.$queryRaw<OriginalMigrationReceipt[]>(sql`
        SELECT migration_name AS migrationName, checksum, started_at AS startedAt, finished_at AS finishedAt,
          rolled_back_at AS rolledBackAt, applied_steps_count AS appliedSteps
        FROM _prisma_migrations ORDER BY started_at, id`) : await database.$queryRaw<OriginalMigrationReceipt[]>(sql`
        SELECT migration_name AS migrationName, checksum, finished_at AS finishedAt, rolled_back_at AS rolledBackAt
        FROM _prisma_migrations ORDER BY started_at, id`);
      result.reason = "ledger_invalid";
      if (!Array.isArray(receipts)) return result;
      const original = receipts.filter(receipt => receipt?.migrationName === migrationName && receipt.rolledBackAt === null);
      if (original.length === 1 && typeof original[0].checksum === "string") extension.receipt = {
        checksum: original[0].checksum, finishedAt: validDate(original[0].finishedAt) ? original[0].finishedAt.toISOString() : null,
        rolledBackAt: null
      };
      extension.execution = { state: "unknown", migration: extension.migration };
      let applied = 0;
      const appliedReceipts: OriginalMigrationReceipt[] = [];
      for (const receipt of receipts) {
        const checksum = checksums.get(receipt?.migrationName);
        result.reason = "ledger_conflict";
        if (checksum === undefined || checksum !== receipt.checksum) return result;
        if (receipt.rolledBackAt !== null) {
          if (mcp || !validDate(receipt.rolledBackAt)) return result;
          continue;
        }
        if (receipt.migrationName !== expected[applied]?.name) return result;
        result.reason = "ledger_incomplete";
        if (!validDate(receipt.finishedAt)) return result;
        if (mcp && (!receipt.startedAt || !validDate(receipt.startedAt) || receipt.finishedAt < receipt.startedAt
          || (receipt.appliedSteps !== 1 && receipt.appliedSteps !== 1n))) return result;
        appliedReceipts.push(receipt);
        applied++;
      }
      result.reason = "ledger_incomplete";
      if (applied !== expected.length) return result;
      extension.execution = { state: "ready" };
      for (const [index, plan] of physical.entries()) {
        result.reason = "physical_unavailable";
        const observed = CorePhysicalDataObservationSchema.safeParse(await plan.read(database));
        result.reason = "physical_mismatch";
        if (!observed.success || observed.data.version !== plan.version) return result;
        result.physical[index].observation = observed.data;
        if (index === physical.length - 1) extension.physical = observed.data;
      }
      const state = (plan: CoreMysqlDataPlan, start: number) => ({ version: plan.data.version, execution: { state: "ready" as const },
        appliedMigrations: appliedReceipts.slice(start, start + plan.migrationNames.length)
          .map((receipt, index) => ({ id: plan.data.migrations[index].id, sha256: receipt.checksum })) });
      let offset = input.platform.migrationNames.length + input.rental.migrationNames.length;
      const dataCapabilities = capabilityPlans.map(({ capabilityId, plan }) => {
        const observed = { capabilityId, ...state(plan, offset) };
        offset += plan.migrationNames.length;
        return observed;
      });
      result.data = CoreDataObservationSchema.parse({ platform: state(input.platform, 0),
        cores: [{ coreId: "rental", ...state(input.rental, input.platform.migrationNames.length) }],
        dataCapabilities });
      result.reason = "verified";
      return result;
    } catch {
      // 原错误可能带连接串或数据库内容，诊断只公开固定阶段原因。
      return result;
    }
  };
  return Object.assign(async (database: Pick<CoreHostSqlTransaction, "$queryRaw">) => {
    const result = await inspect(database);
    if (!result.data) throw unavailable();
    return result.data;
  }, { inspect });
}

export function createFreshRentalAiDataAvailability(input: Parameters<typeof createFreshRentalAiDataObservation>[0]) {
  const observe = createFreshRentalAiDataObservation(input);
  return async (database: Pick<CoreHostSqlTransaction, "$queryRaw">) => { await observe(database); };
}
