/** Rental 普通客户/员工页面与动作贡献。只调用原业务，外壳、持久化及运输由宿主供给。 */
import { ClientError, type ClientContribution, type ClientLifetime, type ClientOperationReference,
  type ClientOperationResult, type ClientScope } from "@rental-os/platform-client-contracts";
import type { ClientOrderView } from "../../src/client-contracts";
import type { RentalOrder, RentalServiceExecutionReceipt } from "../../src/contracts";
import type { RentalClientCancellationReceipt } from "../../src/client-contribution-context";
import { createRentalContributionSession, type RentalContributionSession, type RentalContributionSessionOptions } from "./session";
export { RentalClientHttpError } from "./session";
export type { RentalClientCredentials, RentalContributionTransport, RentalContributionSessionOptions, RentalContributionSession } from "./session";
export type { RentalClientContributionContext, RentalClientCancellationReceipt } from "../../src/client-contribution-context";

export interface RentalContributionOptions extends RentalContributionSessionOptions {
  /** 宿主安全随机生成器；每次新意图唯一，已持久化原键的核对绝不调用本函数。 */
  createOperationKey(): string;
  version: string;
}
const text = (zh: string, en: string) => ({ "zh-CN": zh, "en-US": en });
function id(value: string) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u.test(value)) throw new ClientError("unavailable");
  return value;
}
function reference(options: RentalContributionOptions, routeId: string, actionId: string, targetId: string): ClientOperationReference {
  const key = options.createOperationKey();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key) || targetId.length > 256) throw new ClientError("unavailable");
  return Object.freeze({ coreId: "rental", routeId, actionId, targetId, operationKey: `rental:${actionId}:${key}` });
}
function original(value: ClientOperationReference, routeId: string, actionId: string) {
  if (value.coreId !== "rental" || value.routeId !== routeId || value.actionId !== actionId
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u.test(value.operationKey)) throw new ClientError("unavailable");
  return Object.freeze({ ...value });
}
function once(reference: ClientOperationReference, work: (life: ClientLifetime) => Promise<ClientOperationResult>) {
  let dispatched = false;
  return async (life: ClientLifetime): Promise<ClientOperationResult> => {
    life.assertCurrent();
    if (dispatched) return { status: "unknown", reference };
    dispatched = true;
    try { const result = await work(life); life.assertCurrent(); return result; }
    catch { life.assertCurrent(); return { status: "unknown", reference }; }
  };
}
function customerContribution(bridge: RentalContributionSession, options: RentalContributionOptions): ClientContribution {
  const orderPath = (value: string) => `/orders/${encodeURIComponent(id(value))}`;
  const routeId = "rental.my-order", actionId = "cancel";
  async function receipt(value: ClientOperationReference, scope: ClientScope, life: ClientLifetime): Promise<ClientOperationResult> {
    const ref = original(value, routeId, actionId), orderId = id(ref.targetId);
    const result = await bridge.request<RentalClientCancellationReceipt>(`${orderPath(orderId)}/cancel-receipt`, scope, life, { operationKey: ref.operationKey });
    return result.status === "committed" && result.orderId === orderId && result.operationKey === ref.operationKey
      ? { status: "recorded", reference: ref, message: "原取消操作已记录" } : { status: "unknown", reference: ref };
  }
  return { coreId: "rental", version: options.version, audience: "client", routes: [
    { id: "rental.my-orders", label: text("我的订单", "My orders"), navigation: true,
      async load(_page, scope, life) {
        const page = await bridge.request<{ items: ClientOrderView[]; total: number }>("/orders?page=1&pageSize=50", scope, life);
        return { title: "我的订单", description: "当前经营空间，最多显示最近 50 笔订单", emptyText: "暂无本人订单",
          items: page.items.map(order => ({ id: order.id, title: order.orderNo, status: order.status,
            detail: `${order.startAt} — ${order.effectiveEndAt ?? order.endAt}`,
            destination: { routeId, params: { orderId: order.id } } })) };
      } },
    { id: routeId, label: text("订单详情", "Order details"),
      async load(page, scope, life) {
        const order = await bridge.request<ClientOrderView>(orderPath(page.params.orderId), scope, life);
        return { title: order.orderNo, description: "取消费用及资格以原订单规则核定", emptyText: "暂无订单资料",
          items: [{ id: order.id, title: order.orderNo, status: order.status, detail: `${order.startAt} — ${order.effectiveEndAt ?? order.endAt}` }] };
      }, actions: [{ id: actionId, label: text("取消订单", "Cancel order"),
        fields: [{ name: "reason", label: text("取消原因", "Cancellation reason"), kind: "textarea", required: true, maxLength: 500 }],
        async prepare(page, values, scope, life) {
          const orderId = id(page.params.orderId), reason = values.reason?.trim();
          if (!reason || reason.length > 500) throw new ClientError("unavailable");
          // 仅做原只读取消预览；不能据此替代正式取消的状态、价格与事务复验。
          await bridge.request(`${orderPath(orderId)}/cancel/preview`, scope, life, { body: {} });
          const ref = reference(options, routeId, actionId, orderId);
          return { reference: ref, execute: once(ref, async executeLife => {
            await bridge.request(`${orderPath(orderId)}/cancel`, scope, executeLife, { body: { reason }, operationKey: ref.operationKey });
            return receipt(ref, scope, executeLife);
          }) };
        }, readReceipt: receipt }] }
  ] };
}
function staffContribution(bridge: RentalContributionSession, options: RentalContributionOptions): ClientContribution {
  const orderPath = (value: string) => `/rental/v1/orders/${encodeURIComponent(id(value))}`;
  const routeId = "rental.service-occurrence", actionId = "start";
  function target(value: string) {
    let parsed: unknown;
    try { parsed = JSON.parse(value); } catch { throw new ClientError("unavailable"); }
    if (!Array.isArray(parsed) || parsed.length !== 2) throw new ClientError("unavailable");
    return [id(parsed[0]), id(parsed[1])] as const;
  }
  async function receipt(value: ClientOperationReference, scope: ClientScope, life: ClientLifetime): Promise<ClientOperationResult> {
    const ref = original(value, routeId, actionId), [orderId, occurrenceId] = target(ref.targetId);
    const result = await bridge.request<RentalServiceExecutionReceipt>(`${orderPath(orderId)}/services/${encodeURIComponent(occurrenceId)}/execution-receipt`, scope, life, { operationKey: ref.operationKey });
    return result.status === "committed" && result.order.id === orderId && result.occurrence.occurrenceId === occurrenceId
      && result.occurrence.executionStatus === "in_progress" && Boolean(result.occurrence.actualStartAt)
      ? { status: "recorded", reference: ref, message: "原服务开始操作已记录" } : { status: "unknown", reference: ref };
  }
  return { coreId: "rental", version: options.version, audience: "staff", routes: [
    { id: "rental.service-orders", label: text("订单服务", "Order services"), navigation: true,
      async load(_page, scope, life) {
        const result = await bridge.request<RentalOrder[] | { items: RentalOrder[] }>("/rental/v1/orders?page=1&pageSize=50", scope, life);
        const orders = Array.isArray(result) ? result : result.items;
        return { title: "订单服务", description: "当前受权订单，最多显示 50 笔", emptyText: "暂无受权订单",
          items: orders.slice(0, 50).map(order => ({ id: order.id, title: order.orderNo, status: order.status,
            destination: { routeId: "rental.service-order", params: { orderId: order.id } } })) };
      } },
    { id: "rental.service-order", label: text("订单服务明细", "Order service details"),
      async load(page, scope, life) {
        const order = await bridge.request<RentalOrder>(orderPath(page.params.orderId), scope, life);
        return { title: order.orderNo, emptyText: "本订单没有可定位的服务发生项",
          items: (order.serviceSnapshots ?? []).filter(row => row.occurrenceId && (!scope.locationId || row.serviceLocationId === scope.locationId)).map(row => ({ id: row.occurrenceId!,
            title: row.serviceName, status: row.executionStatus, destination: { routeId, params: { orderId: order.id, occurrenceId: row.occurrenceId! } } })) };
      } },
    { id: routeId, label: text("服务执行", "Service execution"),
      async load(page, scope, life) {
        const order = await bridge.request<RentalOrder>(orderPath(page.params.orderId), scope, life);
        const row = order.serviceSnapshots?.find(item => item.occurrenceId === id(page.params.occurrenceId));
        if (!row || scope.locationId && row.serviceLocationId !== scope.locationId) throw new ClientError("unavailable");
        return { title: row.serviceName, description: order.orderNo, emptyText: "暂无服务资料",
          items: [{ id: row.occurrenceId!, title: row.serviceName, status: row.executionStatus, detail: row.scheduledStartAt }] };
      }, actions: [{ id: actionId, label: text("开始服务", "Start service"),
        async prepare(page, _values, scope, life) {
          const orderId = id(page.params.orderId), occurrenceId = id(page.params.occurrenceId);
          const order = await bridge.request<RentalOrder>(orderPath(orderId), scope, life);
          if (!order.serviceSnapshots?.some(row => row.occurrenceId === occurrenceId && (!scope.locationId || row.serviceLocationId === scope.locationId))) throw new ClientError("unavailable");
          const ref = reference(options, routeId, actionId, JSON.stringify([orderId, occurrenceId]));
          return { reference: ref, execute: once(ref, async executeLife => {
            await bridge.request(`${orderPath(orderId)}/services/${encodeURIComponent(occurrenceId)}/execution`, scope, executeLife,
              { body: { action: "start" }, operationKey: ref.operationKey });
            return receipt(ref, scope, executeLife);
          }) };
        }, readReceipt: receipt }] }
  ] };
}
export function createRentalCustomerClient(options: RentalContributionOptions) {
  const bridge = createRentalContributionSession("client", options);
  return { session: bridge.session, access: bridge.access, contribution: customerContribution(bridge, options) };
}
export function createRentalStaffClient(options: RentalContributionOptions) {
  const bridge = createRentalContributionSession("staff", options);
  return { session: bridge.session, access: bridge.access, contribution: staffContribution(bridge, options) };
}
