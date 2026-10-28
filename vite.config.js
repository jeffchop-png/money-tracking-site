import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS === "true" ? "/money-tracking-site/" : "/",
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3001"
    }
  }
});
