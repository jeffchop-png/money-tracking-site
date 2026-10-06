import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { constants } from "node:fs";
import { access, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const PORT = Number(process.env.PORT) || 3001;
const ACCESS_KEY = process.env.MORG_MONEY_KEY;
const DATA_DIR = path.resolve(process.env.MORG_MONEY_DATA_DIR || "data");
const DATA_FILE = path.join(DATA_DIR, "morg-money.json");
const DIST_DIR = path.resolve("dist");
const SERVE_DIST = process.argv.includes("--serve-dist");
const MAX_BODY_BYTES = 8_000_000;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_SECTIONS = Array.from({ length: 6 }, (_, index) => ({
  id: `section-${index + 1}`,
  name: `Section ${String(index + 1).padStart(2, "0")}`,
  people: []
}));
const sessions = new Map();
const unlockAttempts = new Map();
let store = { revision: 0, sections: DEFAULT_SECTIONS };
let commitQueue = Promise.resolve();

function normalizeSections(input) {
  if (!Array.isArray(input) || (input.length !== 6 && input.length !== 7)) {
    throw new Error("The shared tracker must contain six sections.");
  }

  const sections = input.map((entry, sectionIndex) => {
    const section = entry && typeof entry === "object" ? entry : {};
    const people = Array.isArray(section.people) ? section.people : [];
    return {
      id: `section-${sectionIndex + 1}`,
      name: typeof section.name === "string" && section.name.trim()
        ? section.name.trim().slice(0, 40)
        : `Section ${String(sectionIndex + 1).padStart(2, "0")}`,
      people: people.filter(person => person && typeof person === "object").map(person => ({
        id: typeof person.id === "string" && person.id ? person.id.slice(0, 100) : randomBytes(12).toString("hex"),
        name: typeof person.name === "string" ? person.name.trim().slice(0, 70) : "",
        amount: Number.isFinite(Number(person.amount)) ? Math.round(Number(person.amount) * 100) / 100 : 0,
        currency: typeof person.currency === "string" && /^[a-zA-Z]{3}$/.test(person.currency.trim())
          ? person.currency.trim().toUpperCase()
          : "USD"
      }))
    };
  });

  if (sections.reduce((total, section) => total + section.people.length, 0) > 10000) {
    throw new Error("The shared tracker can contain at most 10,000 people.");
  }
  if (sections.length === 7) {
    sections[5].people.push(...sections[6].people);
    sections.pop();
  }
  return sections;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authenticate(request) {
  const authorization = request.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function enqueueCommit(task) {
  const result = commitQueue.then(task);
  commitQueue = result.catch(() => {});
  return result;
}

async function writeStore(nextStore) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(nextStore, null, 2), { mode: 0o600 });
  await rename(temporaryFile, DATA_FILE);
  store = nextStore;
}

async function serveStatic(request, response, pathname) {
  const requestedPath = decodeURIComponent(pathname);
  const candidate = path.resolve(DIST_DIR, `.${requestedPath}`);
  if (candidate !== DIST_DIR && !candidate.startsWith(`${DIST_DIR}${path.sep}`)) {
    response.writeHead(400).end("Bad request");
    return;
  }

  let filePath = candidate;
  try {
    if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, "index.html");
    const content = await readFile(filePath);
    const contentType = filePath.endsWith(".html") ? "text/html; charset=utf-8"
      : filePath.endsWith(".js") ? "text/javascript; charset=utf-8"
      : filePath.endsWith(".css") ? "text/css; charset=utf-8"
      : filePath.endsWith(".svg") ? "image/svg+xml"
      : "application/octet-stream";
    response.writeHead(200, { "Content-Type": contentType, "X-Content-Type-Options": "nosniff" });
    response.end(content);
  } catch {
    if (request.method === "GET" && !path.extname(pathname)) {
      const html = await readFile(path.join(DIST_DIR, "index.html"));
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
    } else {
      response.writeHead(404).end("Not found");
    }
  }
}

async function handleRequest(request, response) {
  const url = new URL(request.url, "http://localhost");
  try {
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        await access(DATA_DIR, constants.W_OK);
        sendJson(response, 200, { status: "ok", revision: store.revision, uptimeSeconds: Math.floor(process.uptime()) });
      } catch {
        sendJson(response, 503, { status: "storage-unavailable" });
      }
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, store);
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/unlock") {
      const address = request.socket.remoteAddress || "unknown";
      const attempt = unlockAttempts.get(address) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
      if (attempt.resetAt <= Date.now()) {
        attempt.count = 0;
        attempt.resetAt = Date.now() + 15 * 60 * 1000;
      }
      if (attempt.count >= 10) {
        sendJson(response, 429, { error: "Too many attempts. Try again in 15 minutes." });
        return;
      }
      const body = await readJson(request);
      const suppliedHash = createHash("sha256").update(typeof body.key === "string" ? body.key : "").digest();
      const expectedHash = createHash("sha256").update(ACCESS_KEY).digest();
      if (!timingSafeEqual(suppliedHash, expectedHash)) {
        attempt.count += 1;
        unlockAttempts.set(address, attempt);
        sendJson(response, 401, { error: "That key did not match." });
        return;
      }
      unlockAttempts.delete(address);
      const token = randomBytes(32).toString("base64url");
      sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
      sendJson(response, 200, { token, expiresIn: SESSION_TTL_MS });
      return;
    }

    if (request.method === "PUT" && url.pathname === "/api/state") {
      if (!authenticate(request)) {
        sendJson(response, 401, { error: "Editing session expired. Unlock editing again." });
        return;
      }
      const body = await readJson(request);
      if (!Number.isSafeInteger(body.revision)) {
        sendJson(response, 400, { error: "A valid state revision is required." });
        return;
      }
      let sections;
      try {
        sections = normalizeSections(body.sections);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
        return;
      }
      const result = await enqueueCommit(async () => {
        if (body.revision !== store.revision) {
          return { status: 409, value: { error: "The tracker changed in another session.", ...store } };
        }
        const nextStore = { revision: store.revision + 1, sections };
        await writeStore(nextStore);
        return { status: 200, value: nextStore };
      });
      sendJson(response, result.status, result.value);
      return;
    }

    if (SERVE_DIST && request.method === "GET") {
      await serveStatic(request, response, url.pathname);
      return;
    }
    sendJson(response, 404, { error: "Not found." });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error.message === "Request is too large." ? 413 : 500;
    sendJson(response, status, { error: status === 500 ? "The server could not complete the request." : error.message });
    if (status === 500) console.error(error);
  }
}

async function start() {
  if (!ACCESS_KEY) throw new Error("Set MORG_MONEY_KEY in the server environment before starting Morg Money.");
  await mkdir(DATA_DIR, { recursive: true });
  try {
    const saved = JSON.parse(await readFile(DATA_FILE, "utf8"));
    const sections = normalizeSections(saved.sections);
    store = { revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0, sections };
    if (saved.sections.length === 7) {
      store = { revision: store.revision + 1, sections };
      await writeStore(store);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const server = createServer(handleRequest);
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Morg Money API listening on port ${PORT}${SERVE_DIST ? " (serving built site)" : ""}`);
  });
  const shutdown = signal => {
    console.log(`Received ${signal}; finishing active requests.`);
    server.close(() => process.exit(0));
    const forceExit = setTimeout(() => process.exit(1), 10_000);
    forceExit.unref();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
