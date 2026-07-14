export interface BookingSlot {
  court: number;
  beginTime: string;
  endTime: string;
}

function normalizeTime(time: string): string {
  return time.slice(0, 5);
}

function toDisplayTime(time: string): string {
  return normalizeTime(time).replace(":", "H");
}

export function mergeContiguousSlotsByCourt(bookings: BookingSlot[]): BookingSlot[] {
  const byCourt = new Map<number, BookingSlot[]>();
  for (const booking of bookings) {
    const existing = byCourt.get(booking.court) ?? [];
    byCourt.set(booking.court, [...existing, booking]);
  }

  const merged: BookingSlot[] = [];
  for (const slots of byCourt.values()) {
    const sorted = [...slots].sort((a, b) =>
      normalizeTime(a.beginTime).localeCompare(normalizeTime(b.beginTime)),
    );
    let current: BookingSlot | undefined;
    for (const slot of sorted) {
      if (current && normalizeTime(current.endTime) === normalizeTime(slot.beginTime)) {
        current = { ...current, endTime: slot.endTime };
      } else {
        if (current) merged.push(current);
        current = { ...slot };
      }
    }
    if (current) merged.push(current);
  }

  return merged.sort(
    (a, b) => a.court - b.court || normalizeTime(a.beginTime).localeCompare(normalizeTime(b.beginTime)),
  );
}

export function formatMergedCourtSlots(slots: BookingSlot[]): string {
  return slots
    .map((slot) => `Court ${slot.court} : ${toDisplayTime(slot.beginTime)}-${toDisplayTime(slot.endTime)}`)
    .join("\n");
}
