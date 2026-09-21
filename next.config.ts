import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["hkjc-api", "graphql", "graphql-request"],
};

export default nextConfig;

import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
initOpenNextCloudflareForDev();
