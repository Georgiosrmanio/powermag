import http from "node:http";

const PORT = Number(process.env.PORT || 10000);
const ALLOWED_ORIGIN = "https://topcharge.onrender.com";
const PRICE_PER_UNIT = 1180;
const rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

function sendJson(res, status, payload, origin = "") {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(origin === ALLOWED_ORIGIN ? {
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "vary": "Origin"
    } : {})
  });
  res.end(JSON.stringify(payload));
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (rateLimits.get(ip) || []).filter(ts => now - ts < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    rateLimits.set(ip, recent);
    return true;
  }
  recent.push(now);
  rateLimits.set(ip, recent);
  return false;
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) throw new Error("payload_too_large");
  }
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("invalid_json");
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const path = new URL(req.url || "/", "http://localhost").pathname;

  if (req.method === "OPTIONS" && path === "/api/order") {
    if (origin !== ALLOWED_ORIGIN) return sendJson(res, 403, { ok: false }, "");
    res.writeHead(204, {
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "86400",
      "vary": "Origin"
    });
    return res.end();
  }

  if (req.method === "GET" && path === "/healthz") {
    return sendJson(res, 200, { ok: true, service: "topcharge-order-api" });
  }

  if (req.method !== "POST" || path !== "/api/order") {
    return sendJson(res, 404, { ok: false, code: "not_found" });
  }

  if (origin !== ALLOWED_ORIGIN) {
    return sendJson(res, 403, { ok: false, code: "origin_not_allowed" });
  }

  if (isRateLimited(clientIp(req))) {
    return sendJson(res, 429, { ok: false, code: "rate_limited" }, origin);
  }

  let data;
  try {
    data = await readJson(req);
  } catch (error) {
    const status = error.message === "payload_too_large" ? 413 : 400;
    return sendJson(res, status, { ok: false, code: error.message }, origin);
  }

  // Honeypot for basic automated spam.
  if (typeof data.website === "string" && data.website.trim()) {
    return sendJson(res, 200, { ok: true }, origin);
  }

  const name = typeof data.name === "string" ? data.name.trim().slice(0, 80) : "";
  const phone = typeof data.phone === "string" ? data.phone.trim().slice(0, 40) : "";
  const quantity = Number(data.quantity);
  const digits = phone.replace(/\D/g, "");

  if (!name || digits.length < 9 || !Number.isInteger(quantity) || quantity < 1 || quantity > 8) {
    return sendJson(res, 400, { ok: false, code: "invalid_order" }, origin);
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return sendJson(res, 503, { ok: false, code: "not_configured" }, origin);
  }

  const total = quantity * PRICE_PER_UNIT;
  const text = [
    "🛒 Нова заявка TopCharge",
    "",
    `Ім’я: ${name}`,
    `Телефон: ${phone}`,
    `Кількість: ${quantity} шт.`,
    `Сума: ${total.toLocaleString("uk-UA")} грн`,
    `Сторінка: https://topcharge.onrender.com/`
  ].join("\n");

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      console.error("Telegram delivery failed", { status: response.status, error_code: result.error_code || null });
      return sendJson(res, 502, { ok: false, code: "telegram_delivery_failed" }, origin);
    }
    return sendJson(res, 200, { ok: true }, origin);
  } catch {
    console.error("Telegram API request failed");
    return sendJson(res, 502, { ok: false, code: "telegram_unavailable" }, origin);
  }
});

// Temporary setup lookup: log only group IDs, never message text or user data.
async function logTelegramGroupIdsOnce() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=50`);
    const payload = await response.json();
    if (!payload.ok) {
      console.error("Telegram setup lookup failed", { error_code: payload.error_code || null });
      return;
    }
    const groups = new Map();
    for (const update of payload.result || []) {
      const chat = update.message?.chat;
      if (chat && (chat.type === "group" || chat.type === "supergroup")) {
        groups.set(String(chat.id), { id: chat.id, title: chat.title || "", type: chat.type });
      }
    }
    console.log("Telegram group ID candidates:", JSON.stringify([...groups.values()]));
  } catch {
    console.error("Telegram setup lookup failed");
  }
}
void logTelegramGroupIdsOnce();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`TopCharge order API listening on port ${PORT}`);
});
