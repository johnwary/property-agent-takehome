import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// API base URL: same-origin in prod, proxied in dev to avoid CORS.
export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      "/agents": "http://localhost:3001",
    },
  },
});
