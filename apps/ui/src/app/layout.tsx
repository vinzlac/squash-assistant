import type { ReactNode } from "react";
import "./globals.css";
import { UserMenu } from "./components/UserMenu";

export const metadata = {
  title: "squash-assistant — Administration",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <UserMenu />
        {children}
      </body>
    </html>
  );
}
