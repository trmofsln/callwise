import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Callwise | Best time to call",
  description: "Plan seller conversations with calling windows, interaction history, and grounded recommendations.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
