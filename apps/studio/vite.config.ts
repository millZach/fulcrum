import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4311,
    allowedHosts: [".ts.net"],
    proxy: {
      "/api": "http://localhost:4310",
    },
  },
});
