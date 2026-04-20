import "./globals.css";
import type { Metadata } from "next";
import { EB_Garamond } from "next/font/google";
import { Navbar } from "../components/navbar";
import { CompareProvider } from "../lib/compare-context";
import { CompareDrawer } from "../components/compare-drawer";

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Scion",
  description: "Cross-repository lookup and comparison for whole-cell imaging datasets.",
  icons: {
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><ellipse cx="12" cy="16" rx="8" ry="13" stroke="%23888" stroke-width="2" fill="none"/><ellipse cx="20" cy="16" rx="8" ry="13" stroke="%23888" stroke-width="2" fill="none"/></svg>',
  },
};

import React, { Suspense } from "react";

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const showPilot = process.env.NODE_ENV !== "production" || process.env.SCION_ENABLE_PUBLIC_DATA_PILOT === "true";

  return (
    <html lang="en" className={`${ebGaramond.className} ${ebGaramond.variable}`}>
      <body>
        <CompareProvider>
          <Suspense fallback={<nav className="navbar" />}>
            <Navbar showPilot={showPilot} />
          </Suspense>
          {children}
          <Suspense fallback={null}>
            <CompareDrawer />
          </Suspense>
          <footer>Scion – Ad Interiora.</footer>
        </CompareProvider>
      </body>
    </html>
  );
}
