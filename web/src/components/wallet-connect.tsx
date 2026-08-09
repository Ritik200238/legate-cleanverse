"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWallet } from "@/lib/wallet-context";
import { shortAddress } from "@/lib/format";
import { activeChain } from "@/lib/contracts";

export function WalletConnect() {
  const { address, chainId, connecting, error, connect, switchToActiveChain, isOnActiveChain } = useWallet();

  if (!address) {
    return (
      <div className="flex items-center gap-2">
        {error && <span className="text-xs text-destructive max-w-[220px] truncate" title={error}>{error}</span>}
        <Button onClick={connect} disabled={connecting} size="sm">
          {connecting ? "Connecting..." : "Connect Wallet"}
        </Button>
      </div>
    );
  }

  if (!isOnActiveChain) {
    return (
      <div className="flex items-center gap-2">
        <Badge variant="destructive">Wrong network (chain {chainId})</Badge>
        <Button onClick={switchToActiveChain} size="sm" variant="outline">
          Switch to {activeChain.name}
        </Button>
      </div>
    );
  }

  return (
    <Badge variant="secondary" className="font-mono">
      {shortAddress(address)}
    </Badge>
  );
}
