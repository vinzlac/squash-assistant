import { getBookingQr } from "../mcp/resaSquash.js";
import { sendImage } from "../mcp/huddleBot.js";
import type { McpConnection } from "../mcp/client.js";

/** Créneau réservé, réduit à ce qu'il faut pour choisir et retrouver son QR. */
export interface QrBookingCandidate {
  sessionId: string;
  court: number;
  slotTime: string;
}

/**
 * Un QR par court, celui du **premier créneau** (le plus tôt) sur ce court.
 * Une fois le court ouvert avec ce QR, les créneaux suivants sur le même court n'en ont pas
 * besoin — l'accès reste ouvert. Même règle que resa-squash (Q1 de son plan QR), pour que les
 * deux canaux envoient exactement les mêmes images.
 */
export function selectQrBookings(bookings: QrBookingCandidate[]): QrBookingCandidate[] {
  const earliestByCourt = new Map<number, QrBookingCandidate>();
  for (const booking of bookings) {
    const current = earliestByCourt.get(booking.court);
    if (!current || booking.slotTime < current.slotTime) {
      earliestByCourt.set(booking.court, booking);
    }
  }
  return [...earliestByCourt.values()].sort((a, b) => a.court - b.court);
}

/**
 * Envoie sur WhatsApp le QR d'accès de chaque court réservé (un par court).
 *
 * L'URL renvoyée par resa-squash expire en quelques minutes : elle est donc demandée **ici**,
 * juste avant l'envoi, et jamais stockée — c'est aussi pourquoi le rappel J+1 peut réafficher
 * le QR alors que le lien envoyé la veille est mort depuis longtemps.
 *
 * Entièrement best-effort : le QR est un confort, pas la réservation. Un court dont le QR
 * échoue (aucun token TeamR côté resa-squash, TeamR indisponible, envoi WhatsApp refusé) est
 * simplement sauté, sans jamais faire échouer l'annonce ou le rappel déjà envoyés.
 */
export async function sendBookingQrCodes(
  deps: { resaSquash: McpConnection; huddleBot: McpConnection },
  jid: string,
  bookings: QrBookingCandidate[],
): Promise<number> {
  let sent = 0;
  for (const booking of selectQrBookings(bookings)) {
    try {
      const qr = await getBookingQr(deps.resaSquash.client, booking.sessionId);
      if (!qr.url) {
        console.warn(
          `[qr] Aucun QR disponible pour le court ${booking.court} (session ${booking.sessionId}) :`,
          { found: qr.found, qrAvailable: qr.qrAvailable },
        );
        continue;
      }
      await sendImage(deps.huddleBot.client, jid, qr.url, qr.caption);
      sent += 1;
    } catch (err) {
      console.error(`[qr] Échec envoi QR court ${booking.court} (session ${booking.sessionId}) :`, err);
    }
  }
  return sent;
}
