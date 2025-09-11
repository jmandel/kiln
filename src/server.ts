import ui from "../index.html";
import { createApiFetch } from "../server/src/api";
import { join } from "path";

const dbPath = join(import.meta.dir, "..", "server", "db", "terminology.sqlite");
const { fetch: apiFetch } = createApiFetch({ prefix: "", dbPath });

const development = (process.env.NODE_ENV || "").toLowerCase() !== "production";

const server = Bun.serve({
  routes: { "/": ui },
  development,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return ui as unknown as Response;
    return apiFetch(req);
  },
});

console.log(`✅ Dev server (UI + API mounted) at ${server.url}`);
