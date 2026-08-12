import type { Metadata, Viewport } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Backline",
  description:
    "Sing, and the backing track follows you. AI generated instrumentals that adapt to your voice in real time.",
};

export const viewport: Viewport = {
  themeColor: "#0a0710",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
