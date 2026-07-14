import type { Database } from "../db/client.js";
import { events, type EventStatus, type EventType } from "../db/schema.js";
import type { GraphDependencies } from "./dependencies.js";

export function emitEvent(
  db: Database,
  params: { bookingRuleId: string; type: EventType; status: EventStatus; targetDate: string; detail: unknown },
): Promise<unknown> {
  return db.insert(events).values({
    bookingRuleId: params.bookingRuleId,
    type: params.type,
    status: params.status,
    targetDate: params.targetDate,
    detail: params.detail as object,
  });
}

/**
 * Enrobe l'exécution d'un nœud : logue un event "success" (avec le detail
 * renvoyé par fn) ou "error" (avec le message d'exception), puis relance
 * l'erreur pour que le scheduler la reporte sur Telegram comme aujourd'hui.
 */
export async function withEventLogging<T>(
  deps: GraphDependencies,
  params: { bookingRuleId: string; type: EventType; targetDate: string },
  fn: () => Promise<{ result: T; detail: unknown }>,
): Promise<T> {
  try {
    const { result, detail } = await fn();
    await emitEvent(deps.db, { ...params, status: "success", detail });
    return result;
  } catch (err) {
    await emitEvent(deps.db, {
      ...params,
      status: "error",
      detail: { error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
