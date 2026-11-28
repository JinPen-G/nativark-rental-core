/** Fixed v2 materials for the explicit new-install host. The v1 base is used
 * only for registration after the complete lock and its source are checked. */
import { isDeepStrictEqual } from "node:util";
import type { CoreDeploymentLock, CoreManifest, CorePlatformDataCapabilityRelease } from "@rental-os/core-contracts";
import { CorePhasedMigrationLockSchema } from "@rental-os/core-contracts/deployment";
import { readPlatformDataCapabilityPackage } from "@rental-os/core-contracts/platform-data-package";
import { readPublicAiDataPackage, requirePublicAiDataPackage } from "@rental-os/public-ai-data/public-data-package";
import { createPublicPlatformDataPlan } from "@rental-os/platform-api/data-plan";
import type { CoreMysqlDataPlan } from "@rental-os/core-host/mysql-deployment";
import type { CoreHostSqlTransaction } from "@rental-os/core-host/mysql";
import { requireRentalDeploymentPackage } from "./deployment-package";
import { composeRentalPublicAiPrismaSchema, createFreshRentalAiDataObservation, createRentalAiMysqlPlans, readRentalAiDataExtension } from "./ai-data-extension";

type Observation = ReturnType<typeof createFreshRentalAiDataObservation>;
type FixedMcpData = { plan: CoreMysqlDataPlan; readDataPackage(): { root: string; release: CorePlatformDataCapabilityRelease } };

export class FreshRentalAiSelection {
  readonly #lock: ReturnType<typeof CorePhasedMigrationLockSchema.parse>;
  readonly #base: CoreDeploymentLock;
  readonly #dataPlan: ReturnType<typeof createRentalAiMysqlPlans>["publicAi"];
  readonly #dataRoot: string;
  readonly #data: NonNullable<CoreDeploymentLock["dataCapabilities"]>[number];
  readonly #mcp?: FixedMcpData;
  readonly #observe: Observation;
  readonly #schema: string;

  get base() { return structuredClone(this.#base); }
  get lock() { return structuredClone(this.#lock); }
  get schema() { return this.#schema; }

  constructor(input: { lock: unknown; publicAiDirectory: string; publicSchema: string;
    extension: { source: CoreManifest["source"]; files: ReadonlyMap<string, Uint8Array> }; mcp?: FixedMcpData }) {
    const lock = CorePhasedMigrationLockSchema.parse(input.lock);
    const releases = lock.base.dataCapabilities ?? [], ai = releases.find(item => item.id === "ai-native");
    const mcp = releases.find(item => item.id === "mcp");
    if (lock.base.cores.length !== 1 || lock.base.cores[0].manifest.id !== "rental"
      || releases.length !== (input.mcp ? 2 : 1) || !ai || Boolean(mcp) !== Boolean(input.mcp)
      || lock.postCapability.length !== 1) throw new Error("新装锁须与显式选择的 Rental、AI、MCP 数据包及后置扩展一致");
    if (input.mcp && !isDeepStrictEqual(input.mcp.readDataPackage().release, mcp))
      throw new Error("MCP 完整数据包与新装锁不一致");
    const data = readPlatformDataCapabilityPackage(input.publicAiDirectory, ai);
    const rental = requireRentalDeploymentPackage(lock.base.cores[0], lock.base.platform.versions);
    const { contribution } = readPublicAiDataPackage(data.files, data.release);
    const extension = readRentalAiDataExtension(input.extension.files);
    this.#observe = createFreshRentalAiDataObservation({ lock, platform: createPublicPlatformDataPlan(rental.dataPlan.publicForeignKeys),
      rental: rental.dataPlan, publicAiFiles: data.files, extension: input.extension, mcp: input.mcp?.plan });
    this.#dataPlan = createRentalAiMysqlPlans(contribution, extension, data.release).publicAi;
    this.#schema = composeRentalPublicAiPrismaSchema(input.publicSchema, contribution, rental.schema, extension);
    this.#base = lock.base;
    this.#lock = lock;
    this.#data = data.release;
    this.#dataRoot = data.root;
    this.#mcp = input.mcp;
  }

  select(lock: CoreDeploymentLock) {
    if (!isDeepStrictEqual(lock, this.#base)) throw new Error("新装运行登记与已核完整锁不同");
    return structuredClone(this.#base);
  }

  data() {
    const readDataPackages = () => [readPlatformDataCapabilityPackage(this.#dataRoot, this.#data),
      ...(this.#mcp ? [this.#mcp.readDataPackage()] : [])];
    return {
      dataPlan: this.#dataPlan,
      verifyDataPackage: () => { requirePublicAiDataPackage(this.#dataRoot, this.#data); this.#mcp?.readDataPackage(); },
      phasedData: this.#observe, readDataPackages
    };
  }

  /** 仅供同宿主的只读安装观察；实际包每次重核，不将锁声明当成安装事实。
   * 平台运行证据、Client 与初始化由对应宿主读者补齐；这里不判整套 ready。 */
  readInstalled() {
    const lock = this.lock;
    let installed: { cores: CoreDeploymentLock["cores"];
      dataCapabilities: NonNullable<CoreDeploymentLock["dataCapabilities"]> } | null = null;
    let packageReason: "verified" | "package_unavailable" = "package_unavailable";
    try {
      const rental = requireRentalDeploymentPackage(lock.base.cores[0], lock.base.platform.versions);
      const data = this.data();
      data.verifyDataPackage();
      const capabilities = data.readDataPackages();
      const expected = lock.base.dataCapabilities ?? [];
      if (capabilities.length !== expected.length || new Set(capabilities.map(item => item.release.id)).size !== expected.length
        || expected.some(release => !capabilities.some(item => isDeepStrictEqual(item.release, release))))
        throw new Error("实际能力包与原选择不同");
      installed = { cores: [{ manifest: rental.manifest, sha256: rental.sha256 }],
        dataCapabilities: capabilities.map(item => item.release) };
      packageReason = "verified";
    } catch { /* 不输出本地路径、连接信息或底层错误。 */ }
    return { lock, installed, packageReason };
  }

  async inspect(database: Pick<CoreHostSqlTransaction, "$queryRaw">) {
    return { ...this.readInstalled(), observation: await this.#observe.inspect(database) };
  }
}
