import { NextResponse } from "next/server";
import { getAuthentikUser } from "../../../lib/authentik";

/** "Qui suis-je ?" — lit les headers Authentik côté serveur (voir lib/authentik.ts). */
export async function GET() {
  const user = await getAuthentikUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié (headers Authentik absents)." }, { status: 401 });
  }
  return NextResponse.json(user);
}
