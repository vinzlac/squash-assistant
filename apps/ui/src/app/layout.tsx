import type { ReactNode } from "react";
import "./globals.css";
import { UserMenu } from "./components/UserMenu";
import { Footer } from "./components/Footer";

export const metadata = {
  title: "squash-assistant — Administration",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <UserMenu />
        {children}
        <Footer />
      </body>
    </html>
  );
}
