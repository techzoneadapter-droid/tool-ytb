import type { NextConfig } from "next";
const config: NextConfig = {
  devIndicators: false,
  serverExternalPackages: ["mammoth", "sharp"],
};
export default config;
