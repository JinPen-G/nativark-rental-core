/** Web/微信共用的 Rental 会话适配。运输只执行一次请求；凭据采用必须在原请求寿命内。 */
import { ClientError, clientScopeKey, type ClientAccessPort, type ClientAudience, type ClientLifetime,
  type ClientScope, type ClientSession, type ClientSessionPort } from "@rental-os/platform-client-contracts";
import type { RentalClientContributionContext } from "../../src/client-contribution-context";

export interface RentalClientCredentials { readonly accessToken: string; readonly refreshToken: string }
export interface RentalContributionTransport {
  /** path 为 Rental 固定完整 API 路径。只解包原 JSON；不刷新、重放、保存令牌或改变会话。 */
  request<T>(input: { path: string; method: "GET" | "POST"; authorization?: string;
    body?: unknown; headers?: Readonly<Record<string, string>>; lifetime?: ClientLifetime }): Promise<T>;
}
export class RentalClientHttpError extends Error {
  constructor(readonly status: number) { super(`Rental HTTP ${status}`); }
}
export interface RentalContributionSessionOptions {
  tenantCode: string;
  /** 原渠道身份，如 website 或 miniprogram:<appId>；不是业务权限。 */
  clientId?: string;
  transport: RentalContributionTransport;
  credentials: { read(): RentalClientCredentials | undefined; write(value: RentalClientCredentials): void; clear(): void };
}
export interface RentalContributionSession {
  readonly audience: ClientAudience;
  readonly session: ClientSessionPort;
  readonly access: ClientAccessPort;
  request<T>(path: string, scope: ClientScope, lifetime: ClientLifetime,
    options?: { body?: unknown; operationKey?: string }): Promise<T>;
}

export function createRentalContributionSession(audience: ClientAudience, options: RentalContributionSessionOptions): RentalContributionSession {
  const prefix = audience === "client" ? "/api/client/v1" : "/api/staff/v1";
  const listeners = new Set<() => void>();
  let state: ClientSession = { status: "anonymous" }, epoch = 0;
  function publish(value: ClientSession) {
    state = value;
    for (const listener of listeners) { try { listener(); } catch { /* 单个宿主不能阻止旧展示失效。 */ } }
  }
  function capture() {
    const value = options.credentials.read();
    return value ? { accessToken: value.accessToken, refreshToken: value.refreshToken } : undefined;
  }
  function assertAttempt(attempt: number, life: ClientLifetime) {
    life.assertCurrent();
    if (attempt !== epoch) throw new ClientError("stale");
  }
  async function context(credentials: RentalClientCredentials, life: ClientLifetime) {
    return options.transport.request<RentalClientContributionContext>({ path: `${prefix}/auth/contribution-context`,
      method: "GET", authorization: `Bearer ${credentials.accessToken}`, lifetime: life });
  }
  function projection(value: RentalClientContributionContext, location?: { id: string; name: string }): ClientSession & { status: "authenticated" } {
    if (!value || value.audience !== audience || [value.tenantId, value.subjectId, value.workspaceId,
      value.sessionRevision, value.authorizationRevision].some(item => typeof item !== "string" || !item)) throw new ClientError("unavailable");
    return Object.freeze({ status: "authenticated", displayName: value.displayName, tenantName: value.tenantName,
      workspaceName: value.workspaceName, locationName: location?.name, scope: Object.freeze({ principal: Object.freeze({ audience,
        tenantId: value.tenantId, subjectId: value.subjectId }), workspaceId: value.workspaceId,
        locationId: location?.id,
        sessionRevision: `${epoch}:${value.sessionRevision}`, authorizationRevision: value.authorizationRevision }) });
  }
  async function locationFor(credentials: RentalClientCredentials, locationId: string, life: ClientLifetime) {
    const choices = await options.transport.request<{ id: string; name: string }[]>({ path: `${prefix}/rental/v1/contribution-locations`,
      method: "GET", authorization: `Bearer ${credentials.accessToken}`, lifetime: life });
    const location = choices.find(row => row.id === locationId && typeof row.name === "string" && row.name);
    if (!location) throw new ClientError("denied");
    return { id: location.id, name: location.name };
  }
  async function adopt(life: ClientLifetime, work: (current: RentalClientCredentials | undefined) => Promise<RentalClientCredentials>,
    selection?: { workspaceId: string; locationId: string }) {
    const attempt = ++epoch, previous = capture();
    publish({ status: "loading" });
    try {
      const candidate = await work(previous); assertAttempt(attempt, life);
      if (!candidate.accessToken || !candidate.refreshToken) throw new ClientError("unavailable");
      const observed = await context(candidate, life); assertAttempt(attempt, life);
      if (selection && observed.workspaceId !== selection.workspaceId) throw new ClientError("stale");
      const location = selection ? await locationFor(candidate, selection.locationId, life) : undefined;
      const value = projection(observed, location); assertAttempt(attempt, life);
      options.credentials.write(candidate); publish(value);
    } catch (error) {
      assertAttempt(attempt, life);
      options.credentials.clear(); publish({ status: "unavailable" });
      throw error instanceof ClientError ? error : new ClientError("unavailable");
    }
  }
  function assertOwner(scope: ClientScope, life: ClientLifetime) {
    life.assertCurrent();
    if (state.status !== "authenticated" || clientScopeKey(scope) !== clientScopeKey(state.scope)) throw new ClientError("stale");
  }
  async function request<T>(path: string, scope: ClientScope, life: ClientLifetime,
    input: { body?: unknown; operationKey?: string } = {}): Promise<T> {
    assertOwner(scope, life);
    const credentials = capture(), attempt = epoch;
    if (!credentials) throw new ClientError("anonymous");
    try {
      const result = await options.transport.request<T>({ path: `${prefix}${path}`, method: input.body === undefined ? "GET" : "POST",
        authorization: `Bearer ${credentials.accessToken}`, body: input.body,
        headers: { ...(input.operationKey ? { "Idempotency-Key": input.operationKey } : {}),
          ...(audience === "staff" && scope.locationId && path.startsWith("/rental/v1/") && path !== "/rental/v1/contribution-locations"
            ? { "x-rental-location-id": scope.locationId } : {}) }, lifetime: life });
      assertAttempt(attempt, life); assertOwner(scope, life);
      if (capture()?.accessToken !== credentials.accessToken) throw new ClientError("stale");
      return result;
    } catch (error) { assertAttempt(attempt, life); assertOwner(scope, life); throw error; }
  }
  const session: ClientSessionPort = {
    getSnapshot: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    loginFields: [{ name: "account", label: { "zh-CN": audience === "client" ? "手机号" : "员工账号", "en-US": "Account" }, kind: "text", autocomplete: "username" },
      { name: "password", label: { "zh-CN": "密码", "en-US": "Password" }, kind: "password", autocomplete: "current-password" }],
    refresh(life) {
      const selected = state.status === "authenticated" && state.scope.workspaceId && state.scope.locationId
        ? { workspaceId: state.scope.workspaceId, locationId: state.scope.locationId } : undefined;
      return adopt(life, async current => { if (!current) throw new ClientError("anonymous"); return current; }, selected);
    },
    signIn(fields, life) {
      const account = fields.account?.trim(), password = fields.password;
      if (!account || !password || !options.tenantCode.trim()) return Promise.reject(new ClientError("unavailable"));
      return adopt(life, () => options.transport.request<RentalClientCredentials>({ path: `${prefix}/auth/login`, method: "POST", lifetime: life,
        body: audience === "client" ? { tenantCode: options.tenantCode, loginIdentifier: account, password, clientId: options.clientId ?? "website" }
          : { tenantCode: options.tenantCode, account, password } }));
    },
    async signOut() {
      const original = capture(); ++epoch;
      options.credentials.clear(); publish({ status: "anonymous" });
      if (original?.refreshToken) {
        try { await options.transport.request({ path: `${prefix}/auth/logout`, method: "POST", body: { refreshToken: original.refreshToken } }); }
        catch { /* 原撤销失败不能恢复本机身份，也不重试旧请求。 */ }
      }
    },
    async scopeChoices(life) {
      if (state.status !== "authenticated") throw new ClientError("anonymous");
      const scope = state.scope;
      const value = await request<{ workspaces?: { workspaceCode?: string; workspaceName?: string; id?: string; name?: string }[] }>(
        audience === "client" ? "/auth/me" : "/auth/session-context", scope, life);
      const workspaces = (value.workspaces ?? []).flatMap(row => {
        const id = audience === "client" ? row.workspaceCode : row.id, label = audience === "client" ? row.workspaceName : row.name;
        return id && label ? [{ id: audience === "client" ? id : `workspace:${id}`, label: audience === "client" ? label : `经营空间：${label}` }] : [];
      });
      if (audience === "client") return workspaces;
      const locations = await request<{ id: string; name: string }[]>("/rental/v1/contribution-locations", scope, life);
      return [...workspaces, ...locations.map(row => ({ id: `location:${row.id}`, label: `门店：${row.name}` }))];
    },
    selectScope(id, life) {
      if (state.status !== "authenticated" || !id?.trim()) return Promise.reject(new ClientError("anonymous"));
      if (audience === "staff" && id.startsWith("location:")) {
        const workspaceId = state.scope.workspaceId;
        if (!workspaceId || !id.slice(9)) return Promise.reject(new ClientError("denied"));
        return adopt(life, async previous => { if (!previous) throw new ClientError("anonymous"); return previous; },
          { workspaceId, locationId: id.slice(9) });
      }
      if (audience === "staff" && !id.startsWith("workspace:")) return Promise.reject(new ClientError("denied"));
      return adopt(life, async previous => {
        if (!previous) throw new ClientError("anonymous");
        const result = await options.transport.request<RentalClientCredentials>({ path: `${prefix}/auth/switch-workspace`, method: "POST",
          authorization: `Bearer ${previous.accessToken}`, body: audience === "client" ? { workspaceCode: id } : { workspaceId: id.slice(10) }, lifetime: life });
        return { accessToken: result.accessToken, refreshToken: result.refreshToken || previous.refreshToken };
      });
    }
  };
  const routes = audience === "client" ? ["rental.my-orders", "rental.my-order"] : ["rental.service-orders", "rental.service-order", "rental.service-occurrence"];
  const action = audience === "client" ? "cancel" : "start";
  const access: ClientAccessPort = { async authorize(input, life) {
    if (input.coreId !== "rental" || !routes.includes(input.routeId) || input.actionId && input.actionId !== action
      || !["page", "action", "original_receipt"].includes(input.purpose)
      || input.scope.principal.audience !== audience) return { status: "denied" };
    assertOwner(input.scope, life);
    try {
      const observed = await request<RentalClientContributionContext>("/auth/contribution-context", input.scope, life);
      const credentials = capture();
      // 原收据不经普通目录准入，停用 Core 后仍由原历史读口复核地点和对象。
      const location = audience === "staff" && input.scope.locationId && credentials
        ? input.purpose === "original_receipt"
          ? { id: input.scope.locationId, name: state.status === "authenticated" ? state.locationName ?? "" : "" }
          : await locationFor(credentials, input.scope.locationId, life)
        : undefined;
      assertOwner(input.scope, life);
      const current = projection(observed, location);
      if (clientScopeKey(current.scope) !== clientScopeKey(input.scope)) { publish(current); throw new ClientError("stale"); }
      // 普通页面只核读权但必须经过当前 Core 准入。原收据保留独立历史权限，
      // 停用页面不能封死未知操作恢复，历史读取也不能反过来授权普通页面或动作。
      const accessPath = input.purpose === "page" ? "/contribution-page-access"
        : input.purpose === "action" ? "/contribution-access" : "/orders?page=1&pageSize=1";
      const result = await request<{ allowed?: boolean }>(`${audience === "client" ? "" : "/rental/v1"}${accessPath}`, input.scope, life);
      if (input.purpose !== "original_receipt" && result?.allowed !== true) return { status: "unavailable" };
      return { status: "allowed" };
    } catch (error) {
      assertOwner(input.scope, life);
      if (error instanceof ClientError && error.code === "stale") throw error;
      if (error instanceof RentalClientHttpError && [401, 403, 404].includes(error.status)) return { status: "denied" };
      return { status: "unavailable" };
    }
  } };
  return { audience, session, access, request };
}
