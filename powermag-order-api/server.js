import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = "https://powermag.onrender.com";
const rateLimits = new Map();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 8;

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
  const paymentMethod = clean(data.paymentMethod, 20);
  const deliveryLabels = { branch: "Відділення", postomat: "Поштомат", courier: "Кур’єр" };
  const paymentLabels = {
    cod: "Оплата при отриманні (накладений платіж)",
    prepay: "Перед відправленням (передплата за реквізитами)"
  };
  const items = normalizeItems(data.items);
  if (name.length < 2 || digits.length < 9 || !items || !deliveryLabels[deliveryType] ||
      city.length < 2 || destination.length < 2 || !paymentLabels[paymentMethod]) {
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
    "",
    "Доставка: Нова пошта — " + deliveryLabels[deliveryType],
    "Населений пункт: " + city,
    "Відділення / адреса: " + destination,
    "Оплата: " + paymentLabels[paymentMethod],
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
