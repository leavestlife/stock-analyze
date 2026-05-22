import { handleRequest } from "../server.mjs";

export default async function handler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/__static")) {
    const staticPath = url.pathname.replace(/^\/api\/__static/, "") || "/";
    req.url = `${staticPath}${url.search}`;
  }
  return handleRequest(req, res);
}
