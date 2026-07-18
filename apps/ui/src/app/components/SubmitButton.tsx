"use client";

import { useFormStatus } from "react-dom";

type Props = {
  children: React.ReactNode;
  className?: string;
};

export function SubmitButton({ children, className }: Props) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending}>
      {pending ? "…" : children}
    </button>
  );
}
