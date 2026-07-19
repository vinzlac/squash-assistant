"use client";

import { useFormStatus } from "react-dom";

type Props = {
  children: React.ReactNode;
  className?: string;
  /** Route ce bouton vers une action différente de celle du <form> englobant (plusieurs boutons, un seul form). */
  formAction?: (formData: FormData) => void | Promise<void>;
};

export function SubmitButton({ children, className, formAction }: Props) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} formAction={formAction}>
      {pending && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}
