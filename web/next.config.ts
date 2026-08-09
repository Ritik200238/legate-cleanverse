import type { NextConfig } from "next";

const BACKEND_URL = process.env.LEGATE_BACKEND_URL ?? "http://127.0.0.1:4021";
const RPC_RELAY_URL = process.env.LEGATE_RPC_RELAY_URL ?? "http://127.0.0.1:8546";

// Only proxy when a backend was actually configured, or in local development where the
// defaults are correct. A hosted build with no backend would otherwise forward every /api
// call to 127.0.0.1 — from the server's own loopback — and sit there until it times out.
// A fast 404 that the DeploymentStatus banner already explains beats a slow 502 that
// nothing explains.
const ENABLE_PROXY = Boolean(process.env.LEGATE_BACKEND_URL) || process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  // Dev-only: allows the tunnel host to fetch the dev server's JS bundle / HMR socket.
  // Without this, Next.js 16 silently blocks those cross-origin requests — the page renders
  // its initial HTML fine but never hydrates, so nothing on it is actually interactive
  // (discovered exactly this way during browser testing; see DECISIONS.md).
  allowedDevOrigins: ["*.loca.lt"],
  // Proxies same-origin requests to the backend (and, in local dev/testing, the RPC relay —
  // see backend/test/browser-relay.ts) so the browser never needs direct network access to
  // them — required when this dev server is reached through a tunnel rather than directly on
  // localhost, and it also means only ONE tunnel is needed instead of two.
  async rewrites() {
    if (!ENABLE_PROXY) return [];
    return [
      { source: "/api/:path*", destination: `${BACKEND_URL}/api/:path*` },
      { source: "/pay/:path*", destination: `${BACKEND_URL}/pay/:path*` },
      { source: "/rpc", destination: RPC_RELAY_URL },
    ];
  },
};

export default nextConfig;
