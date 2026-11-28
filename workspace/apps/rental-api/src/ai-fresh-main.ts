/** Explicit fresh-only AI entry. Resolve complete fixed materials before
 * starting the original Rental lifecycle; never adopt a v1 or mixed ledger. */
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CoreSourceSchema } from "@rental-os/core-contracts";
import { readCorePackageOrdinaryFile } from "@rental-os/platform-core-host/core-package-preflight";
import { FreshRentalAiSelection } from "./ai-fresh-selection";
import { RENTAL_AI_EXTENSION_FILES } from "./ai-data-extension";
import { createRentalAiHostModule } from "./ai-app.module";
import type { RentalAiPlatformRetentionFactory } from "./ai-composition";
import { bootstrapFreshRentalComposition } from "./bootstrap";
import { readFreshRentalClientObservation } from "./ai-installation-observation";

const hostRoot = resolve(__dirname, "..");

export function bootstrapFreshRentalAi(platformRetention?: RentalAiPlatformRetentionFactory) {
  return bootstrapFreshRentalComposition(async lock => {
    const publicAiDirectory = process.env.RENTAL_PUBLIC_AI_DATA_PACKAGE_DIR ?? "";
    if (!isAbsolute(publicAiDirectory)) throw new Error("新装须配置固定公共 AI 归档解包目录的绝对路径");
    const fresh = await readFreshRentalAiSelection(lock, publicAiDirectory);
    const base = fresh.base;
    return { base, register: () => createRentalAiHostModule({ lock: base, fresh, platformRetention }) };
  });
}

/** Consume the fixed build's source receipt, original extension and selected Client. */
export async function readFreshRentalAiSelection(lock: unknown, publicAiDirectory: string,
  mcp?: NonNullable<ConstructorParameters<typeof FreshRentalAiSelection>[0]["mcp"]>) {
  const read = (file: string) => readCorePackageOrdinaryFile(resolve(hostRoot, file), 32 * 1024 * 1024);
  const [sourceBytes, publicBytes] = await Promise.all([
    read("prisma/ai-extension/runtime-source.json"), read("../platform-api/prisma/schema.prisma")
  ]);
  const source: unknown = JSON.parse(sourceBytes.toString("utf8"));
  if (typeof source !== "object" || source === null || !("format" in source) || source.format !== "rental-fresh-ai-runtime-1"
    || !("platform" in source) || !("rental" in source) || !("extension" in source))
    throw new Error("新装缺少固定双仓运行来源回执");
  const extension = { source: CoreSourceSchema.parse(source.extension),
    files: new Map(await Promise.all(RENTAL_AI_EXTENSION_FILES.map(async ({ file }) => [file, await read(file)] as const))) };
  const fresh = new FreshRentalAiSelection({ lock, publicAiDirectory, publicSchema: publicBytes.toString("utf8"), extension, mcp });
  const base = fresh.base;
  if (!isDeepStrictEqual(CoreSourceSchema.parse(source.rental), base.cores[0].manifest.source)
    || !isDeepStrictEqual(CoreSourceSchema.parse(source.platform), base.platform.source))
    throw new Error("新装完整锁与固定双仓运行来源不一致");
  const mcpRelease = base.dataCapabilities?.find(item => item.id === "mcp");
  if (!isDeepStrictEqual("mcp" in source ? source.mcp : undefined,
    mcpRelease && { source: mcpRelease.source, sha256: mcpRelease.sha256 }))
    throw new Error("新装 MCP 锁与固定数据包运行来源不一致");
  // Prisma formats the generated copy; compare its original semantic tokens.
  await readFreshRentalClientObservation(fresh.schema);
  return fresh;
}

if (require.main === module) void bootstrapFreshRentalAi().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.name : "Error"}: Rental AI 新装启动失败\n`);
  process.exitCode = 1;
});
