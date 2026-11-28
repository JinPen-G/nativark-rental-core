/** 门店选择只收窄原员工已获范围，不改会话、角色或地点授权；当前地点与对象仍须原服务端复验。 */
import { ForbiddenException } from "@nestjs/common";
import type { RentalOrder } from "./contracts";

export const RENTAL_CLIENT_LOCATION_HEADER = "x-rental-location-id";
export function rentalClientLocationId(request: { headers?: Record<string, unknown> }): string | undefined {
  const value = request.headers?.[RENTAL_CLIENT_LOCATION_HEADER];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/u.test(value)) {
    throw new ForbiddenException("门店选择无效，请重新选择已授权的履约地点");
  }
  return value;
}

export function assertRentalClientOrderLocation(locationId: string | undefined,
  order: Pick<RentalOrder, "fulfillmentLocationId" | "returnLocationId" | "serviceSnapshots">, occurrenceId?: string) {
  if (!locationId) return;
  if (order.fulfillmentLocationId !== locationId && order.returnLocationId !== locationId) {
    throw new ForbiddenException("订单不属于当前所选门店");
  }
  if (occurrenceId && !order.serviceSnapshots?.some(row => row.occurrenceId === occurrenceId && row.serviceLocationId === locationId)) {
    throw new ForbiddenException("服务发生项不属于当前所选门店");
  }
}
