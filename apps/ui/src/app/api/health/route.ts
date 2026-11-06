export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sonde Kubernetes (readiness + liveness). Volontairement sans dépendance : pas de base, pas de MCP,
 * pas de lecture de session. La page `/` attend huddle-bot (≈ 0,7 à 1,5 s) et dépassait le timeout
 * d'1 s des sondes : voir k3s-homelab, alertes du 2026-11-06.
 */
export async function GET() {
  return Response.json({ status: "ok" });
}
