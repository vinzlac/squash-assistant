"use client";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const DEBOUNCE_MS = 1500;

export function ResaEventsLive({ chatJid }: { chatJid: string }) {
  const router = useRouter();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/resa-events");
    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as { chatJid?: string };
        if (data.chatJid !== chatJid) return;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => router.refresh(), DEBOUNCE_MS);
      } catch { /* ignore */ }
    };
    return () => {
      es.close();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [chatJid, router]);

  return null;
}
