// api/check-ban.js
import { HttpsProxyAgent } from "https-proxy-agent";

/**
 * Vercel serverless endpoint: POST /api/check-ban
 * Body: { number: "+62812345678" }
 *
 * Environment variables:
 * - PROXIES (optional): newline-separated list of http(s) proxy URLs (e.g. http://user:pass@1.2.3.4:8000)
 * - RATE_LIMIT_PER_MIN (optional): default 30 requests per minute per IP
 * - MAX_RETRIES (optional): default 2
 */

const UA_LIST = [
  // UA variants found in WhatsApp / mods — rotate through these
  "WhatsApp/2.23.8.76 Android/13 Device/Pixel",
  "WhatsApp/2.22.18 Android/12 Device/Generic",
  "WhatsApp/2.21.23 Android/11 Device/Samsung",
  "Mozilla/5.0 (Linux; Android 11) AppleWebKit/537.36 (KHTML, like Gecko) WhatsApp/2.21.23"
];

const MCC_OPTIONS = ["510","440","510","520","310","404","505"]; // sample MCCs (ID, JP, etc.)
const MNC_OPTIONS = ["00","01","10","20","70","01"]; // sample MNCs
const DEFAULT_RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MIN || "30", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "2", 10);

// In-memory rate limiter (serverless: ephemeral — good for low-volume usage)
const rateMap = new Map(); // key: ip, value: { count, windowStart }

// helpers
function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function allowedByRateLimit(ip) {
  const windowLen = 60; // seconds
  const limit = DEFAULT_RATE_LIMIT;
  const cur = nowUnix();
  const rec = rateMap.get(ip);
  if (!rec) {
    rateMap.set(ip, { count: 1, windowStart: cur });
    return true;
  }
  if (cur - rec.windowStart >= windowLen) {
    // reset window
    rateMap.set(ip, { count: 1, windowStart: cur });
    return true;
  }
  if (rec.count < limit) {
    rec.count += 1;
    return true;
  }
  return false;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function normalizeNumber(input) {
  // Expect E.164 or a +country number. Return { cc, in } or null
  if (!input || typeof input !== "string") return null;
  const s = input.trim();
  // allow numbers like "+6281234" or "6281234"
  const plus = s.startsWith("+") ? s.slice(1) : s;
  if (!/^\d{6,15}$/.test(plus)) return null;
  // heuristics: country code is first 1-3 digits. For this use, we'll allow
  // user to send full E164 and we'll split as cc = first 1-3 digits chosen greedily
  // Common approach: try splitting into (1,2,3) and pick 2 as default if length allows.
  // Safer: let user input full number and we try cc lengths 1..3 and attempt register for each? For now split: cc = first 2 if len>=8 else 1
  let cc = plus.slice(0, 2);
  if (plus.length < 8) cc = plus.slice(0, 1);
  // but if cc starts with '0' correct it by removing leading zeros
  cc = cc.replace(/^0+/, "") || plus.slice(0,1);
  const inPart = plus.slice(cc.length);
  if (!inPart) return null;
  return { cc, in: inPart };
}

function buildFormBody({ cc, inPart, method="sms", mcc, mnc }) {
  // The APK used x-www-form-urlencoded style pairs:
  // cc, in, method=sms, mcc, mnc ...
  const params = new URLSearchParams();
  params.append("cc", cc);
  params.append("in", inPart);
  params.append("method", method); // sms, flashcall
  if (mcc) params.append("mcc", mcc);
  if (mnc) params.append("mnc", mnc);
  // add small randomized fields that mods often send
  params.append("r", Math.floor(Math.random() * 1000000).toString());
  return params.toString();
}

async function doRegisterCheck(numberObj, proxyUrl, retries=0) {
  const ua = pickRandom(UA_LIST);
  const mcc = pickRandom(MCC_OPTIONS);
  const mnc = pickRandom(MNC_OPTIONS);
  const body = buildFormBody({ cc: numberObj.cc, inPart: numberObj.in, method: "sms", mcc, mnc });

  // Endpoint taken from APK strings
  const endpoint = "https://v.whatsapp.net/v2/register";

  // Setup fetch options
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": ua,
    "Accept": "*/*",
    "Connection": "keep-alive"
  };

  const fetchOptions = {
    method: "POST",
    headers,
    body,
    // follow: 0 is not used here; node fetch follows by default
    // We may add timeout by using AbortController if desired
  };

  // Add proxy agent if provided
  if (proxyUrl) {
    try {
      const agent = new HttpsProxyAgent(proxyUrl);
      fetchOptions.agent = agent;
    } catch (e) {
      console.warn("Proxy agent setup failed:", e);
    }
  }

  // perform request
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000); // 12s timeout
  fetchOptions.signal = controller.signal;

  try {
    const resp = await fetch(endpoint, fetchOptions);
    clearTimeout(timeout);
    const text = await resp.text();

    // heuristics to detect banned vs ok. APK used keywords like 'banned' or similiar responses.
    // Typical responses: "status: fail" + reason 'bad-token' or 'banned' or 401-like errors.
    const low = (text || "").toLowerCase();

    // Many mods look for these markers — adjust if your APK uses other strings
    if (/banned|blocked|account suspended|account banned|forbidden/.test(low)) {
      return { banned: true, raw: text, status: resp.status };
    }

    // If whatsapp returns success codes or "code":"ok" or similar
    if (/code.*ok|status.*ok|\"status\"\:\"ok\"|\"code\"\:\"0\"/.test(low)) {
      return { banned: false, raw: text, status: resp.status };
    }

    // If 401/403/400 responses may indicate banned / blocked depending on body
    if (resp.status >= 400 && resp.status < 500) {
      // treat suspicious 4xx with 'banned' keywords as banned, otherwise unknown
      if (/forbidden|unauthorized|auth_failure|auth_failed|banned/.test(low)) {
        return { banned: true, raw: text, status: resp.status };
      }
    }

    // fallback: treat ambiguous responses as not banned but return raw for inspection
    return { banned: false, raw: text, status: resp.status };
  } catch (err) {
    clearTimeout(timeout);
    // network error or timeout; we can retry
    if (retries < MAX_RETRIES) {
      // small jittered backoff
      await new Promise(r => setTimeout(r, 500 + Math.floor(Math.random() * 700)));
      return doRegisterCheck(numberObj, proxyUrl, retries + 1);
    }
    return { error: "network_error", message: String(err) };
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Basic rate-limiting per IP (ephemeral)
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
  if (!allowedByRateLimit(ip)) {
    return res.status(429).json({ error: "rate_limited", message: `Too many requests (limit ${DEFAULT_RATE_LIMIT}/min)` });
  }

  const body = req.body && typeof req.body === "object" ? req.body : JSON.parse(await req.text().catch(()=>"{}"));
  const number = (body.number || body.phone || "").toString().trim();

  if (!number) {
    return res.status(400).json({ error: "number_required", message: "Send { number: \"+6281234...\" } in request body" });
  }

  const normalized = normalizeNumber(number);
  if (!normalized) {
    return res.status(400).json({ error: "invalid_number", message: "Number must be digits with country code (E.164 recommended)." });
  }

  // Load proxies from env (if provided)
  const proxiesEnv = process.env.PROXIES || "";
  const proxies = proxiesEnv.split("\n").map(s => s.trim()).filter(Boolean);

  // pick a proxy (or undefined)
  let proxyToUse = undefined;
  if (proxies.length > 0) {
    proxyToUse = pickRandom(proxies);
  }

  // Do the check
  const result = await doRegisterCheck({ cc: normalized.cc, in: normalized.in }, proxyToUse);

  if (result && result.error) {
    return res.status(502).json({ error: "proxy_or_network_failed", details: result });
  }

  // Successful: return structured result
  return res.json({
    number,
    normalized,
    banned: !!result.banned,
    statusCode: result.status,
    raw: (process.env.EXPOSE_RAW === "1") ? result.raw : undefined,
    proxy: proxyToUse ? "used" : "none"
  });
}