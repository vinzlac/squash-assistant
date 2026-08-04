export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const base = process.env.LISTENER_INTERNAL_URL;
  if (!base) {
    return new Response("LISTENER_INTERNAL_URL manquant", { status: 500 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(`${base.replace(/\/$/, "")}/events`, {
      headers: { Accept: "text/event-stream" },
      cache: "no-store",
    });
  } catch {
    return new Response("listener injoignable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response("listener erreur", { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
