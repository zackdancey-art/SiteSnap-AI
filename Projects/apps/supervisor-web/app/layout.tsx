import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SiteSnap AI — Manager Portal",
  description: "Manager analytics and site oversight portal for SiteSnap AI",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
