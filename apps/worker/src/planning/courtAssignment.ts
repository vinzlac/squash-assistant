/** Créneau libre d'un court (list_availability resa-squash), entrée du moteur de plan. */
export interface AvailableSlot {
  sessionId: string;
  court: number;
  beginTime: string;
  endTime: string;
}
