import ui from "../index.html";
import viewer from "../viewer.html";
import { createApiFetch } from "../server/src/api";
import { join } from "path";

const dbPath = join(import.meta.dir, "..", "server", "db", "terminology.sqlite");
const { fetch: apiFetch } = createApiFetch({ prefix: "", dbPath });

const development = (process.env.NODE_ENV || "").toLowerCase() !== "production";

const server = Bun.serve({
  routes: { "/": ui, "/viewer": viewer },
  development,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return ui as unknown as Response;
    if (url.pathname === "/viewer") return viewer as unknown as Response;
    
    // Serve static files from public directory
    if (url.pathname.startsWith("/public/")) {
      const filePath = join(import.meta.dir, "..", url.pathname);
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }
    }
    
    return apiFetch(req);
  },
});

console.log(`✅ Dev server (UI + API mounted) at ${server.url}`);
