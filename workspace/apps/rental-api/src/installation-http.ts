/** 完整分阶段安装的 SaaS 只读入口，独立于 v1 包管理；身份仍由公共 Guard 和原事务围栏核定。 */
import { BadRequestException, Controller, ForbiddenException, Get, Header, Inject, Module, Query, type DynamicModule } from "@nestjs/common";
import { CorePhasedInstallationObservationSchema, PHASED_INSTALLATION_HTTP,
  type CorePhasedInstallationObservation } from "@rental-os/core-contracts/phased-installation";
import type { PlatformOpenApiDocument } from "@rental-os/core-contracts";
import type { RegisteredCoreHttpAccess } from "@rental-os/platform-server";
import { getRequestIdentity } from "@rental-os/platform-server/request-identity";
import { hasEffectivePermission } from "@rental-os/platform-server/permission-match";

export interface RentalInstallationStatus { read(): Promise<CorePhasedInstallationObservation> }
const token = Symbol("rental.installation.status");
export function createRentalInstallationHttpAccess(application: RentalInstallationStatus | undefined,
  original: RegisteredCoreHttpAccess): RegisteredCoreHttpAccess {
  const selected = (method: string, path: string) => Boolean(application)
    && method.toUpperCase() === PHASED_INSTALLATION_HTTP.method && path === "/" + PHASED_INSTALLATION_HTTP.path;
  return {
    registered: (method, path, audience) => audience === "operator" && selected(method, path) || original.registered(method, path, audience),
    async authorize(method, path) {
      if (!selected(method, path)) return original.authorize(method, path);
      const actor = getRequestIdentity();
      if (!actor?.userId || actor.audience !== "operator" || !actor.isSaasAdmin
        || !hasEffectivePermission(actor.permissions ?? [], "system:tenant:manage"))
        throw new ForbiddenException("安装观察需要当前 SaaS 管理身份和租户管理权限");
    }
  };
}
@Controller(PHASED_INSTALLATION_HTTP.path)
export class RentalInstallationStatusController {
  constructor(@Inject(token) private readonly application: RentalInstallationStatus) {}
  @Get() @Header("Cache-Control", "no-store")
  async read(@Query() query: Record<string, unknown>) {
    if (!query || Object.keys(query).length) throw new BadRequestException("安装观察不接受查询参数");
    return CorePhasedInstallationObservationSchema.parse(await this.application.read());
  }
}
@Module({})
export class RentalInstallationStatusModule {
  static register(input: { imports: DynamicModule[]; inject: symbol[]; useFactory: (...values: any[]) => RentalInstallationStatus }): DynamicModule {
    return { module: RentalInstallationStatusModule, imports: input.imports, controllers: [RentalInstallationStatusController],
      providers: [{ provide: token, inject: input.inject, useFactory: input.useFactory }] };
  }
}
export function withRentalInstallationOpenApi(document: PlatformOpenApiDocument): PlatformOpenApiDocument {
  const result = structuredClone(document), path = "/api/" + PHASED_INSTALLATION_HTTP.path;
  if (result.paths[path]) throw new Error("安装观察路由已经登记");
  result.paths[path] = { get: { operationId: "rentalPhasedInstallationStatus", tags: ["安装观察"],
    summary: "读取当前完整分阶段安装事实", permissions: ["system:tenant:manage"],
    "x-requiredPermissions": ["system:tenant:manage"], "x-permissionAudience": "saas", security: [{ bearerAuth: [] }],
    responses: { "200": { description: "正式 phased-installation 合同；缺依据为 null/not_checked，禁止缓存" },
      "400": { description: "本入口不接受查询参数" }, "401": { description: "原会话缺失或失效" },
      "403": { description: "当前 SaaS 身份或租户管理权限拒绝" } } } };
  return result;
}
