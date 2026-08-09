import type { Metadata } from "next";
import { Poppins, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import { DecimalsGuard } from "@/components/decimals-guard";
import { DeploymentStatus } from "@/components/deployment-status";
import { WalletProvider } from "@/lib/wallet-context";
import "./globals.css";

// Legate brand: Cleanverse-aligned palette (see brand.md) — Poppins across headings and
// body, matching Cleanverse's own single-font system.
const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Legate — Compliant cross-border stablecoin payments",
  description: "A compliant cross-border stablecoin payment rail for humans and AI agents, built on Cleanverse's real on-chain compliance validator on Monad.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${poppins.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <WalletProvider>
          <Nav />
          <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-8">
            <DecimalsGuard />
            <DeploymentStatus />
            {children}
          </main>
        </WalletProvider>
      </body>
    </html>
  );
}
