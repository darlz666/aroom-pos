import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AROOM POS",
  description: "Point of Sale for AROOM Coffee Bar",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-dvh flex-col">{children}</body>
    </html>
  );
}
