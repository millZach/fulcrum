import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  ...(process.env.FULCRUM_SKIP_DOTENV === "true" ? { envDir: false } : {}),
  plugins: [react()],
  server: {
    port: 4311,
    allowedHosts: [".ts.net"],
    proxy: {
      "/api":
        process.env.FULCRUM_ORCHESTRATOR_URL ?? "http://localhost:4310",
    },
  },
});
