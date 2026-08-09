"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletConnect } from "./wallet-connect";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/send", label: "Send" },
  { href: "/claim", label: "Claim" },
  { href: "/agent", label: "Agent Console" },
  { href: "/auditor", label: "Auditor" },
];

export function Nav() {
  const pathname = usePathname();
  return (
    <header className="border-b border-border">
      <div className="mx-auto max-w-5xl flex items-center justify-between px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-primary text-primary text-xs font-bold">
            L
          </span>
          Legate
        </Link>
        <nav className="hidden sm:flex items-center gap-1">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                "px-3 py-1.5 rounded-md text-sm transition-colors",
                pathname === link.href ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <WalletConnect />
      </div>
    </header>
  );
}
