#!/usr/bin/env node
/*
 * Backend server for the NFN Academy app.
 *
 * Replaces the window.claude db/downloads APIs with a real shared backend so
 * the app works as a fully functional multi-user application: all data is stored
 * server-side in a JSON file (persisted to a volume) and pushed to clients in
 * real time via Server-Sent Events. The static frontend (HTML + db-client.js)
 * is served from the same origin, so there are no CORS issues.
 *
 * Uses only built-in Node.js modules — no dependencies, no build step.
 *
 * Environment:
 *   PORT        listen port (default 3000)
 *   ROOT        directory for static files (default cwd)
 *   INDEX       file served for "/" (default football-academy.html)
 *   STORE_FILE  path to the JSON store file (default <ROOT>/.data/store.json)
 *   BASE44_PREVIEW_MODE  "1" inside the Base44 sandbox (visibility only)
 */
import { createServer } from "node:http";
import { readFile, writeFile, readdir, stat, mkdir } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extname, join, resolve, dirname } from "node:path";

const PORT = Number(process.env.PORT || 3000);
const HOST = "0.0.0.0";
const ROOT = resolve(process.env.ROOT || process.cwd());
const INDEX = process.env.INDEX || "football-academy.html";
const STORE_FILE = process.env.STORE_FILE || join(ROOT, ".data", "store.json");

/* ---------- JSON store ---------- */
let store = {};
function loadStore() {
  try {
    store = JSON.parse(readFileSync(STORE_FILE, "utf8"));
  } catch {
    store = {};
  }
}
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      mkdirSync(dirname(STORE_FILE), { recursive: true });
      writeFileSync(STORE_FILE, JSON.stringify(store));
    } catch (e) {
      console.error("store save failed:", e.message);
    }
  }, 300);
}
loadStore();

/* ---------- SSE ---------- */
const sseClients = new Set();
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

/* ---------- helpers ---------- */
function send(res, status, type, body) {
  const buf = typeof body === "string" ? Buffer.from(body) : body;
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": buf.length
  });
  res.end(buf);
}
function sendJSON(res, status, obj) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((fulfil, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => fulfil(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* split a doc path like "settings/academy" into [collection, id] */
function splitPath(path) {
  const idx = path.indexOf("/");
  if (idx === -1) return [path, ""];
  return [path.slice(0, idx), path.slice(idx + 1)];
}

/* ---------- static file serving ---------- */
const SKIP = new Set([".git", "node_modules", "dist", "build", ".next", "__pycache__", ".venv", ".cache", ".data"]);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

const RELOAD = `<script>
(function(){
  var known=null;
  function check(){
    fetch("/__base44_version",{cache:"no-store"})
      .then(function(r){return r.ok?r.text():null})
      .then(function(v){if(v===null)return;if(known===null){known=v;return}if(v!==known)location.reload()})
      .catch(function(){});
  }
  check();setInterval(check,1200);
})();
</script>`;

async function signature(dir, depth, acc) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (depth < 6) await signature(full, depth + 1, acc);
      continue;
    }
    try {
      const info = await stat(full);
      acc.files += 1;
      acc.size += info.size;
      if (info.mtimeMs > acc.mtime) acc.mtime = info.mtimeMs;
    } catch { /* ignore */ }
  }
  return acc;
}

async function version() {
  const s = await signature(ROOT, 0, { files: 0, size: 0, mtime: 0 });
  return `${s.mtime}-${s.files}-${s.size}`;
}

async function serveStatic(req, res, pathname) {
  if (pathname === "/" || pathname === "") pathname = "/" + INDEX;
  let file = resolve(join(ROOT, "." + pathname));
  if (file !== ROOT && !file.startsWith(ROOT + "/")) {
    return send(res, 403, "text/plain; charset=utf-8", "Forbidden");
  }
  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      file = join(file, INDEX);
      await stat(file);
    }
    const type = TYPES[extname(file)] || "application/octet-stream";
    const body = await readFile(file);
    let out = body;
    if (extname(file) === ".html") {
      const html = body.toString("utf8");
      const idx = html.lastIndexOf("</body>");
      if (idx !== -1) {
        out = Buffer.from(html.slice(0, idx) + RELOAD + html.slice(idx), "utf8");
      }
    }
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      "content-length": out.length
    });
    res.end(out);
  } catch {
    send(res, 404, "text/plain; charset=utf-8", "Not found");
  }
}

/* ---------- request handler ---------- */
async function handle(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return send(res, 400, "text/plain; charset=utf-8", "Bad request");
  }

  /* live-reload signature */
  if (pathname === "/__base44_version") {
    return send(res, 200, "text/plain; charset=utf-8", await version());
  }

  /* SSE */
  if (pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "connection": "keep-alive",
      "x-accel-buffering": "no"
    });
    res.write(": connected\n\n");
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  /* API: /api/c/:col  (list) */
  let m;
  if ((m = pathname.match(/^\/api\/c\/([^/]+)$/)) && req.method === "GET") {
    const col = decodeURIComponent(m[1]);
    const colData = store[col] || {};
    const docs = Object.entries(colData).map(([id, data]) => ({ id, data }));
    return sendJSON(res, 200, docs);
  }

  /* API: /api/c/:col/:id  (get, put, delete) */
  if ((m = pathname.match(/^\/api\/c\/([^/]+)\/(.+)$/)) && m[2]) {
    const col = decodeURIComponent(m[1]);
    const id = decodeURIComponent(m[2]);
    if (!store[col]) store[col] = {};

    if (req.method === "GET") {
      const data = store[col][id];
      if (data === undefined) return sendJSON(res, 200, null);
      return sendJSON(res, 200, data);
    }

    if (req.method === "PUT") {
      const body = await readBody(req);
      let obj;
      try { obj = JSON.parse(body); } catch { return send(res, 400, "text/plain", "Invalid JSON"); }
      store[col][id] = obj;
      scheduleSave();
      broadcast("change", { collection: col, id, data: obj });
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "DELETE") {
      delete store[col][id];
      scheduleSave();
      broadcast("change", { collection: col, id, data: null });
      return sendJSON(res, 200, { ok: true });
    }
  }

  /* fallback: static files */
  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res, pathname);
  }
  return send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
}

const server = createServer((req, res) => {
  handle(req, res).catch(e => {
    console.error("request error:", e);
    if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", "Server error");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`NFN Academy server listening on http://${HOST}:${PORT}`);
  console.log(`  root: ${ROOT}`);
  console.log(`  store: ${STORE_FILE}`);
});
