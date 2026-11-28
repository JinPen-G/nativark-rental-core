/** Rental 客户端的最小身份观察；仅从原 Auth/Guard 的受权上下文投影，不接受客户端主体。 */
export interface RentalClientContributionContext {
  audience: "client" | "staff";
  tenantId: string;
  subjectId: string;
  workspaceId: string;
  sessionRevision: string;
  authorizationRevision: string;
  displayName: string;
  tenantName: string;
  workspaceName?: string;
  canAct: boolean;
}

/** 已有 order.cancel 原记录的最小只读结果；unknown 不证明未提交。 */
export type RentalClientCancellationReceipt =
  | { status: "committed"; orderId: string; operationKey: string }
  | { status: "unknown"; orderId: string; operationKey: string };
