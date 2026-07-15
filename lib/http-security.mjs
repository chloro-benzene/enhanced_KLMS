import { getAuthUser, refreshSession } from "./supabase.mjs";

export class HttpError extends Error {
  constructor(status, message, code = "REQUEST_FAILED") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readJsonBody(request, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new HttpError(413, "送信データが大きすぎます。");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSONの形式が正しくありません。");
  }
}

function parseCookies(request) {
  const cookies = {};
  for (const part of String(request.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function setSessionCookies(response, session) {
  const expiresIn = Number(session.expires_in ?? 3600);
  response.setHeader("Set-Cookie", [
    cookie("klms_access", session.access_token, { maxAge: Math.max(60, expiresIn - 30) }),
    cookie("klms_refresh", session.refresh_token, { maxAge: 30 * 24 * 60 * 60 })
  ]);
}

export function clearSessionCookies(response) {
  response.setHeader("Set-Cookie", [
    cookie("klms_access", "", { maxAge: 0 }),
    cookie("klms_refresh", "", { maxAge: 0 })
  ]);
}

export async function getSessionUser(request, response, { required = true } = {}) {
  const cookies = parseCookies(request);
  if (cookies.klms_access) {
    try {
      return { user: await getAuthUser(cookies.klms_access), accessToken: cookies.klms_access };
    } catch {
      // 期限切れの場合はrefresh tokenで一度だけ更新する。
    }
  }

  if (cookies.klms_refresh) {
    try {
      const session = await refreshSession(cookies.klms_refresh);
      setSessionCookies(response, session);
      return { user: session.user, accessToken: session.access_token };
    } catch {
      clearSessionCookies(response);
    }
  }

  if (required) throw new HttpError(401, "ログインが必要です。", "AUTH_REQUIRED");
  return null;
}

export function assertMutationRequest(request) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method ?? "")) return;
  if (request.headers["x-klms-csrf"] !== "1") {
    throw new HttpError(403, "不正なリクエストを拒否しました。");
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    throw new HttpError(403, "異なるサイトからの操作を拒否しました。");
  }
  const origin = request.headers.origin;
  if (origin) {
    const expectedHost = request.headers.host;
    if (new URL(origin).host !== expectedHost) {
      throw new HttpError(403, "送信元を確認できません。");
    }
  }
}

const rateLimits = new Map();

export function assertRateLimit(key, { limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
  const now = Date.now();
  const current = rateLimits.get(key);
  if (!current || now >= current.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new HttpError(429, "試行回数が多すぎます。しばらく待ってから再試行してください。");
  }
}

export function cleanText(value, { max = 500, required = false } = {}) {
  const text = String(value ?? "").trim();
  if (required && !text) throw new HttpError(400, "必須項目を入力してください。");
  if (text.length > max) throw new HttpError(400, `入力は${max}文字以内にしてください。`);
  return text;
}

export function assertUuid(value) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value))) {
    throw new HttpError(400, "IDの形式が正しくありません。");
  }
  return String(value);
}
