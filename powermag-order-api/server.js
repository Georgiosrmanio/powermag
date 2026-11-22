import http from "node:http";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = "https://powermag.onrender.com";
const rateLimits = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 8;

const NP_DIRECTORY_TTL = 6 * 60 * 60 * 1000;
let npDirectoryCache = null;
let npDirectoryLoading = null;

function normalizeSearch(value) {
  return String(value || "").toLocaleLowerCase("uk").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

async function streamDirectoryItems(url, onItem) {
  const response = await fetch(url, { headers: { "Accept-Language": "uk" }, signal: AbortSignal.timeout(90000) });
  if (!response.ok || !response.body) throw new Error("np_directory_download_failed");
  const stream = Readable.fromWeb(response.body).pipe(createGunzip());
  const decoder = new TextDecoder("utf-8");
  let buffer = "", cursor = 0, itemStart = -1, depth = 0, inString = false, escaped = false, started = false, finished = false;
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    if (!started) {
      const marker = buffer.indexOf('"items"');
      const arrayStart = marker < 0 ? -1 : buffer.indexOf("[", marker);
      if (arrayStart < 0) {
        buffer = buffer.slice(-32);
        continue;
      }
      cursor = arrayStart + 1;
      started = true;
    }
    for (let i = cursor; i < buffer.length; i++) {
      const ch = buffer[i];
      if (itemStart < 0) {
        if (ch === "{") {
          itemStart = i;
          depth = 1;
          inString = false;
          escaped = false;
        } else if (ch === "]") {
          finished = true;
          cursor = i + 1;
          break;
        }
        continue;
      }
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        const item = JSON.parse(buffer.slice(itemStart, i + 1));
        onItem(item);
        itemStart = -1;
        cursor = i + 1;
      }
    }
    if (finished) break;
    if (itemStart >= 0) {
      buffer = buffer.slice(itemStart);
      cursor = 0;
      itemStart = 0;
    } else {
      buffer = buffer.slice(cursor);
      cursor = 0;
    }
  }
  if (!started || !finished) throw new Error("np_directory_invalid_archive");
}

function compactDivision(item) {
  return {
    id: item.id,
    name: clean(item.name, 220),
    shortName: clean(item.shortName || item.name, 220),
    settlementId: item.settlement?.id,
    city: clean(item.settlement?.name, 120),
    region: clean(item.parent?.name || item.region?.name, 120),
    address: clean(item.address, 240),
    number: clean(item.number, 30),
    category: clean(item.divisionCategory, 30),
    status: clean(item.status, 30)
  };
}

async function loadNovaPoshtaDirectory() {
  if (npDirectoryCache && Date.now() - npDirectoryCache.loadedAt < NP_DIRECTORY_TTL) return npDirectoryCache;
  if (npDirectoryLoading) return npDirectoryLoading;
  npDirectoryLoading = (async () => {
    const versionsResponse = await fetch("https://api.novapost.com/divisions/versions", {
      headers: { "Accept-Language": "uk" },
      signal: AbortSignal.timeout(15000)
    });
    if (!versionsResponse.ok) throw new Error("np_directory_versions_failed");
    const versions = await versionsResponse.json();
    const files = [versions?.base_version?.url, ...(versions?.deltas || []).map(delta => delta.url)].filter(Boolean);
    if (!files.length || files.length > 80) throw new Error("np_directory_versions_invalid");
    const allowed = new Set(["PostBranch", "CargoBranch", "Postomat"]);
    const divisions = new Map();
    for (const file of files) {
      await streamDirectoryItems(file, item => {
        if (item.countryCode !== "UA") return;
        const id = String(item.id ?? "");
        if (!id) return;
        if (item.status !== "Working" || !allowed.has(item.divisionCategory) || !item.settlement?.id) {
          divisions.delete(id);
          return;
        }
        divisions.set(id, compactDivision(item));
      });
    }
    if (!divisions.size) throw new Error("np_directory_empty");
    const citiesById = new Map();
    for (const item of divisions.values()) {
      const id = String(item.settlementId);
      if (!citiesById.has(id)) citiesById.set(id, { id: item.settlementId, name: item.city, region: item.region });
    }
    const cities = [...citiesById.values()].sort((a, b) => a.name.localeCompare(b.name, "uk"));
    npDirectoryCache = { loadedAt: Date.now(), divisions: [...divisions.values()], cities };
    return npDirectoryCache;
  })().catch(error => {
    console.error("Nova Poshta directory unavailable", { message: String(error?.message || "unknown").slice(0, 120) });
    throw error;
  }).finally(() => { npDirectoryLoading = null; });
  return npDirectoryLoading;
}

function reply(res, status, body, origin = "") {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  };
  if (origin === ALLOWED_ORIGIN) {
    headers["access-control-allow-origin"] = ALLOWED_ORIGIN;
    headers.vary = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  return typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.socket.remoteAddress || "unknown";
}

function limited(ip) {
  const now = Date.now();
  const recent = (rateLimits.get(ip) || []).filter(ts => now - ts < WINDOW_MS);
  if (recent.length >= MAX_PER_WINDOW) {
    rateLimits.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateLimits.set(ip, recent);
  return false;
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 12000) throw new Error("payload_too_large");
  }
  try { return JSON.parse(raw || "{}"); }
  catch { throw new Error("invalid_json"); }
}

function clean(value, limit) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function normalizeItems(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) return null;
  const items = [];
  for (const row of input) {
    const name = clean(row?.name, 140);
    const qty = Number(row?.qty);
    const price = clean(row?.price, 40);
    if (!name || !Number.isInteger(qty) || qty < 1 || qty > 99) return null;
    items.push({ name, qty, price });
  }
  return items;
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const path = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "GET" && path === "/healthz") {
    return reply(res, 200, { ok: true, service: "powermag-orders-api" });
  }

  if (req.method === "GET" && (path === "/api/np/cities" || path === "/api/np/divisions")) {
    if (origin !== ALLOWED_ORIGIN) return reply(res, 403, { ok: false, code: "origin_not_allowed" });
    try {
      const directory = await loadNovaPoshtaDirectory();
      const query = new URL(req.url || "/", "http://localhost").searchParams;
      if (path === "/api/np/cities") {
        const term = normalizeSearch(query.get("q"));
        if (term.length < 2) return reply(res, 200, { ok: true, items: [] }, origin);
        const items = directory.cities
          .filter(city => normalizeSearch(city.name).includes(term) || normalizeSearch(city.region).includes(term))
          .sort((a, b) => Number(normalizeSearch(b.name).startsWith(term)) - Number(normalizeSearch(a.name).startsWith(term)) || a.name.localeCompare(b.name, "uk"))
          .slice(0, 30);
        return reply(res, 200, { ok: true, items }, origin);
      }
      const settlementId = String(query.get("settlementId") || "");
      const category = String(query.get("category") || "");
      if (!settlementId || !["PostBranch", "CargoBranch", "Postomat"].includes(category)) {
        return reply(res, 400, { ok: false, code: "invalid_location_query" }, origin);
      }
      const term = normalizeSearch(query.get("q"));
      const items = directory.divisions
        .filter(item => String(item.settlementId) === settlementId && item.category === category &&
          (!term || normalizeSearch(item.name + " " + item.address + " " + item.number).includes(term)))
        .sort((a, b) => a.name.localeCompare(b.name, "uk", { numeric: true }));
      return reply(res, 200, { ok: true, items }, origin);
    } catch {
      return reply(res, 503, { ok: false, code: "np_directory_unavailable" }, origin);
    }
  }

  if (req.method === "OPTIONS" && path === "/api/order") {
    if (origin !== ALLOWED_ORIGIN) return reply(res, 403, { ok: false });
    res.writeHead(204, {
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      vary: "Origin"
    });
    return res.end();
  }

  if (req.method !== "POST" || path !== "/api/order") {
    return reply(res, 404, { ok: false, code: "not_found" });
  }
  if (origin !== ALLOWED_ORIGIN) return reply(res, 403, { ok: false, code: "origin_not_allowed" });
  if (limited(clientIp(req))) return reply(res, 429, { ok: false, code: "rate_limited" }, origin);

  let data;
  try { data = await readJson(req); }
  catch (error) {
    const tooLarge = error.message === "payload_too_large";
    return reply(res, tooLarge ? 413 : 400, { ok: false, code: error.message }, origin);
  }

  if (clean(data.website, 200)) return reply(res, 200, { ok: true }, origin);

  const name = clean(data.name, 80);
  const phone = clean(data.phone, 40);
  const digits = phone.replace(/\D/g, "");
  const comment = clean(data.comment, 800);
  const deliveryType = clean(data.deliveryType, 20);
  const city = clean(data.city, 100);
  const destination = clean(data.destination, 180);
  const deliveryLabels = { branch: "Відділення", postomat: "Поштомат", courier: "Кур’єр" };
  const hasDelivery = Boolean(deliveryType || city || destination);
  const items = normalizeItems(data.items);
  if (name.length < 2 || digits.length < 9 || !items ||
      (hasDelivery && (!deliveryLabels[deliveryType] || city.length < 2 || destination.length < 2))) {
    return reply(res, 400, { ok: false, code: "invalid_order" }, origin);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return reply(res, 503, { ok: false, code: "not_configured" }, origin);

  const itemLines = items.map((item, index) => {
    const price = item.price ? " — " + item.price : "";
    return (index + 1) + ". " + item.name + " × " + item.qty + price;
  });
  const message = [
    "🛒 Нова заявка — PowerMag",
    "",
    "Ім’я: " + name,
    "Телефон: " + phone,
    ...(hasDelivery ? [
      "",
      "Доставка: Нова пошта — " + deliveryLabels[deliveryType],
      "Населений пункт: " + city,
      "Відділення / адреса: " + destination
    ] : []),
    "",
    "Замовлення:",
    ...itemLines,
    ...(comment ? ["", "Коментар: " + comment] : []),
    "",
    "Сайт: https://powermag.onrender.com/"
  ].join("\n");

  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      console.error("Telegram delivery failed", { status: response.status, error_code: result.error_code || null });
      return reply(res, 502, { ok: false, code: "telegram_delivery_failed" }, origin);
    }
    return reply(res, 200, { ok: true }, origin);
  } catch (error) {
    console.error("Telegram API request failed", {
      name: typeof error?.name === "string" ? error.name : "Error",
      code: typeof error?.cause?.code === "string" ? error.cause.code : null
    });
    return reply(res, 502, { ok: false, code: "telegram_unavailable" }, origin);
  }
});

server.listen(PORT, "0.0.0.0", () => console.log("PowerMag orders API listening on port " + PORT));
