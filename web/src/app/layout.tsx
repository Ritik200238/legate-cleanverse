import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Nav } from "@/components/nav";
import { DecimalsGuard } from "@/components/decimals-guard";
import { WalletProvider } from "@/lib/wallet-context";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
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
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <WalletProvider>
          <Nav />
          <main className="flex-1 mx-auto w-full max-w-5xl px-4 py-8">
            <DecimalsGuard />
            {children}
          </main>
        </WalletProvider>
      </body>
    </html>
  );
}
