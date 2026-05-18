import "./globals.css";
import type { Metadata } from "next";
import { EB_Garamond } from "next/font/google";
import { Navbar } from "../components/navbar";
import { CompareProvider } from "../lib/compare-context";
import { CompareDrawer } from "../components/compare-drawer";
import { BetaSignupPrompt } from "../components/beta-signup-prompt";

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
});

export const metadata: Metadata = {
  title: "Cell Anatomy",
  description: "Cross-repository lookup and comparison for whole-cell imaging datasets.",
  icons: {
    icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="250 198 700 504"><defs><mask id="m"><rect x="250" y="198" width="700" height="504" fill="white"/><rect x="570" y="198" width="60" height="504" fill="black"/><rect x="400" y="285" width="400" height="330" rx="20" ry="20" fill="black"/></mask></defs><rect x="250" y="200" width="700" height="500" rx="28" ry="28" fill="%23171511" mask="url(%23m)"/></svg>',
  },
};

import React, { Suspense } from "react";

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  const showPilot = process.env.NODE_ENV !== "production" || process.env.SCION_ENABLE_PUBLIC_DATA_PILOT === "true";
  const currentYear = new Date().getFullYear();

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
          <BetaSignupPrompt />
          <footer>© {currentYear} General Cell Anatomy Group - Ad Interiora.</footer>
        </CompareProvider>
      </body>
    </html>
  );
}
