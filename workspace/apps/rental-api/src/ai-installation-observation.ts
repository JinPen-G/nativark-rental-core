/** 新装宿主的只读事实，供安装诊断复用。调用方负责同一身份事务；
 * 不初始化账号/品类，不生成 Client，不以这些局部事实判整套部署 ready。 */
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { CoreArtifactHashSchema, CorePackagePathSchema, CoreSourceSchema } from "@rental-os/core-contracts";
import { CORE_ARCHIVE_LIMITS } from "@rental-os/core-contracts/archive";
import { CorePhasedMigrationLockSchema } from "@rental-os/core-contracts/deployment";
import { readPackageArtifacts } from "@rental-os/core-contracts/package";
import { PlatformManagementRepository } from "@rental-os/platform-server";
import { readCorePackageOrdinaryFile } from "@rental-os/platform-core-host/core-package-preflight";
import { readRentalCategoryInitialization } from "@rental-os/rental-core/initialize-categories";
import { Prisma } from "../generated/client";
import type { ConfigService } from "@nestjs/config";
import { dirname, isAbsolute, join } from "node:path";
import { readCoreArchive } from "@rental-os/core-contracts/archive";
import { CorePackageArtifactSchema, createPlatformCorePackageArchiveIndexSource, inspectCorePackageArtifact }
  from "@rental-os/platform-core-host/core-package-preflight";
import { readPhasedPlatformRuntimeEvidence } from "@rental-os/platform-core-host/core-package-deployment";
import type { RentalDatabaseClient, RentalDatabaseTransaction } from "./database";
import { samePrismaSchema } from "./ai-fresh-schema";
import { RENTAL_AI_EXTENSION_FILES, readRentalAiDataExtension } from "./ai-data-extension";

const artifact = z.object({ file: CorePackagePathSchema, sha256: CoreArtifactHashSchema });
const preparedFile = z.object({ path: CorePackagePathSchema, bytes: z.number().int().nonnegative(), sha256: CoreArtifactHashSchema });
const contextSchema = z.object({ format: z.literal("rental-host-context-1"), installation: z.literal("fresh-ai"),
  ledgerVersion: z.literal(2), deployment: z.literal("pending"), deploymentLockSha256: CoreArtifactHashSchema,
  deploymentProvenance: z.literal("rental-host.deployment-provenance.json"),
  files: z.array(artifact).min(1).max(CORE_ARCHIVE_LIMITS.files) });
const preparedSchema = z.object({ format: z.literal("rental-host-deployment-provenance-1"), state: z.literal("prepared"),
  deployment: z.literal("pending"), installation: z.literal("fresh-ai"), lock: preparedFile, schema: preparedFile,
  migrationLock: preparedFile, postCapability: CorePhasedMigrationLockSchema.shape.postCapability,
  data: z.object({ platform: z.unknown(), cores: z.unknown(), capabilities: z.unknown() }),
  files: z.array(preparedFile).min(1).max(CORE_ARCHIVE_LIMITS.files) });

/** 与原包管理共用受控归档索引；只接受完整 v2 锁对应的实际公共六包。 */
export async function readFreshRentalPlatformObservation(configuration: Pick<ConfigService, "get">, value: unknown) {
  const lock = CorePhasedMigrationLockSchema.parse(value);
  const storage = configuration.get<string>("CORE_PACKAGE_STORAGE_ROOT");
  const reference = configuration.get<string>("CORE_PLATFORM_PACKAGE_REFERENCE");
  if (!storage || !reference) return null;
  if (!isAbsolute(storage)) throw new Error("Core 包存储根须为宿主配置的绝对目录");
  const artifact = CorePackageArtifactSchema.parse(await createPlatformCorePackageArchiveIndexSource({
    directory: join(storage, "archives") }).read(reference));
  if (artifact.kind !== "platform" || !isDeepStrictEqual(artifact.release, lock.base.platform)
    || !inspectCorePackageArtifact(artifact, undefined, {}).ok) throw new Error("底座归档与原完整锁不一致");
  const directories = ["packages/platform-contracts", "packages/core-contracts", "packages/core-host",
    "packages/platform-server", "packages/platform-core-host", "apps/platform-api"];
  const entries = [require.resolve("@rental-os/platform-contracts"), require.resolve("@rental-os/core-contracts"),
    require.resolve("@rental-os/core-host"), require.resolve("@rental-os/platform-server"),
    require.resolve("@rental-os/platform-core-host"), require.resolve("@rental-os/platform-api/data-plan")];
  const verified = readPhasedPlatformRuntimeEvidence({ directory: resolve(dirname(entries[5]), "../../.."), lock,
    runtimeDirectories: new Map(directories.map((directory, index) => [directory, resolve(dirname(entries[index]), "..") ])),
    runtimeEntries: new Map(directories.map((directory, index) => [directory, entries[index]])),
    platformFiles: readCoreArchive(artifact.bytes, artifact.release.sha256).files,
    receiptFile: "rental-host.context.json", deploymentLockFile: "apps/rental-api/prisma-deployment/core.deployment.lock.json" });
  return verified ? structuredClone(lock.base.platform) : null;
}

/** 只读取宿主打包器的原 prepared 记录及其原字节。不存在不重建回执，
 * prepared/deployment:pending 不表示服务运行或数据已迁移。 */
export async function readFreshRentalPreparation(value: unknown) {
  const lock = CorePhasedMigrationLockSchema.parse(value), root = resolve(__dirname, "../../..");
  const context = contextSchema.parse(JSON.parse((await readCorePackageOrdinaryFile(resolve(root, "rental-host.context.json"), 8 * 1024 * 1024)).toString("utf8")));
  const expected = context.files.find(item => item.file === context.deploymentProvenance);
  if (!expected || new Set(context.files.map(item => item.file)).size !== context.files.length)
    throw new Error("原准备材料清单缺失或重复");
  const verified = readPackageArtifacts(root, [expected], CORE_ARCHIVE_LIMITS.fileBytes, CORE_ARCHIVE_LIMITS.totalBytes);
  const prepared = preparedSchema.parse(JSON.parse(Buffer.from(verified.files.get(expected.file)!).toString("utf8")));
  if (prepared.lock.path !== "core.deployment.lock.json" || prepared.schema.path !== "schema.prisma"
    || prepared.migrationLock.path !== "migrations/migration_lock.toml"
    || !isDeepStrictEqual(prepared.postCapability, lock.postCapability)
    || !isDeepStrictEqual(prepared.data, { platform: lock.base.platform, cores: lock.base.cores, capabilities: lock.base.dataCapabilities ?? [] })
    || prepared.lock.sha256 !== context.deploymentLockSha256
    || new Set(prepared.files.map(item => item.path)).size !== prepared.files.length
    || [prepared.lock, prepared.schema, prepared.migrationLock].some(item => !prepared.files.some(file => isDeepStrictEqual(file, item))))
    throw new Error("原准备结果与完整锁不同");
  const files = prepared.files.map(item => ({ file: "apps/rental-api/prisma-deployment/" + item.path, sha256: item.sha256 }));
  if (files.some(item => !context.files.some(file => isDeepStrictEqual(file, item)))) throw new Error("准备文件不属于原宿主材料");
  const actual = readPackageArtifacts(root, files, CORE_ARCHIVE_LIMITS.fileBytes, CORE_ARCHIVE_LIMITS.totalBytes);
  if (prepared.files.some(item => actual.files.get("apps/rental-api/prisma-deployment/" + item.path)?.byteLength !== item.bytes)
    || !isDeepStrictEqual(CorePhasedMigrationLockSchema.parse(JSON.parse(Buffer.from(
      actual.files.get("apps/rental-api/prisma-deployment/core.deployment.lock.json")!).toString("utf8"))), lock))
    throw new Error("实际部署材料与完整锁不同");
  return { state: "prepared" as const, deployment: "pending" as const, sha256: expected.sha256, lockSha256: prepared.lock.sha256 };
}

/** 扩展按实际宿主目录读取，来源、原 schema/SQL/溯源摘要都保留。 */
export async function readFreshRentalExtensionObservation(value: unknown) {
  const lock = CorePhasedMigrationLockSchema.parse(value), root = resolve(__dirname, "..");
  const source = z.object({ format: z.literal("rental-fresh-ai-runtime-1"), platform: CoreSourceSchema,
    rental: CoreSourceSchema, extension: CoreSourceSchema }).parse(JSON.parse((await readCorePackageOrdinaryFile(
      resolve(root, "prisma/ai-extension/runtime-source.json"), 8 * 1024 * 1024)).toString("utf8")));
  if (lock.postCapability.length !== 1 || !isDeepStrictEqual(source.extension, lock.postCapability[0].migration.source)
    || !isDeepStrictEqual(source.rental, lock.base.cores[0].manifest.source) || !isDeepStrictEqual(source.platform, lock.base.platform.source))
    throw new Error("实际扩展来源与完整锁不同");
  const files = new Map(await Promise.all(RENTAL_AI_EXTENSION_FILES.map(async item => [item.file,
    await readCorePackageOrdinaryFile(resolve(root, item.file), 32 * 1024 * 1024)] as const)));
  readRentalAiDataExtension(files);
  return { source: source.extension, files: RENTAL_AI_EXTENSION_FILES.map(item => ({ ...item })) };
}

/** 与新装启动采用同一语义比较，同时核实际加载 Client 的模型集合。 */
export async function readFreshRentalClientObservation(schema: string) {
  const bytes = await readCorePackageOrdinaryFile(resolve(__dirname, "../generated/client/schema.prisma"), 32 * 1024 * 1024);
  const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map(item => item[1]).sort();
  if (!samePrismaSchema(bytes.toString("utf8"), schema) || !isDeepStrictEqual(Object.keys(Prisma.ModelName).sort(), models))
    throw new Error("新装 Rental AI Client 与固定 schema 不一致");
  return { state: "verified" as const, schemaSha256: createHash("sha256").update(schema).digest("hex"), models: models.length };
}

/** 平台部分保持原 installation 的固定账号、当前角色及原初始化收据语义。
 * 返回投影不包含账号、口令、日志内容或业务授权。 */
export async function readFreshRentalInitialization(database: RentalDatabaseClient, transaction: RentalDatabaseTransaction) {
  const tenant = await transaction.tenant.findUnique({ where: { code: "platform" }, select: { id: true } });
  let platform: { state: "uninitialized" | "initialized" | "conflict"; receipt?: "recorded" | "not_found"; mustChangePassword?: boolean };
  if (!tenant) {
    const remnants = await Promise.all([
      transaction.user.findUnique({ where: { id: "user_saas_admin" }, select: { id: true } }),
      transaction.role.findUnique({ where: { id: "role_saas_admin" }, select: { id: true } }),
      transaction.organizationUnit.findUnique({ where: { id: "org_saas_platform" }, select: { id: true } }),
      transaction.tenant.findUnique({ where: { id: "tenant_platform" }, select: { id: true } })
    ]);
    platform = { state: remnants.some(Boolean) ? "conflict" : "uninitialized" };
  } else {
    const admin = await new PlatformManagementRepository(database).findUserById("user_saas_admin", transaction);
    if (!admin?.isSaasAdmin || admin.tenantId !== tenant.id || !admin.permissions.includes("system:tenant:manage")
      || !admin.permissions.includes("system:tenant:bootstrap")) platform = { state: "conflict" };
    else {
      const receipt = await transaction.operationLog.findFirst({ where: { tenantId: tenant.id,
        userId: "user_saas_admin", action: "platform.initialized" }, select: { id: true } });
      platform = { state: "initialized", receipt: receipt ? "recorded" : "not_found", mustChangePassword: admin.mustChangePassword };
    }
  }
  const categories = await readRentalCategoryInitialization(transaction);
  const receipt = tenant ? await transaction.operationLog.findFirst({ where: { tenantId: tenant.id,
    userId: "user_saas_admin", action: "rental.categories.initialized" }, select: { id: true } }) : null;
  return { platform, cores: [{ coreId: "rental" as const, ...categories,
    receipt: receipt ? "recorded" as const : "not_found" as const }] };
}
