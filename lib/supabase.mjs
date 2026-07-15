import { loadDotEnv } from "./canvas-client.mjs";

export class SupabaseError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
    this.details = details;
  }
}

export function getSupabaseConfig() {
  loadDotEnv();
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error("Supabaseの環境変数が未設定です。READMEのセットアップ手順を確認してください。");
  }
  return { url, anonKey, serviceRoleKey };
}

async function parseResponse(response) {
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const message = body?.msg ?? body?.message ?? body?.error_description ?? body?.error ?? "Supabase request failed";
    throw new SupabaseError(message, response.status, body);
  }
  return body;
}

async function request(path, { method = "GET", body, accessToken, serviceRole = false, prefer } = {}) {
  const { url, anonKey, serviceRoleKey } = getSupabaseConfig();
  const apiKey = serviceRole ? serviceRoleKey : anonKey;
  const headers = {
    apikey: apiKey,
    Authorization: `Bearer ${accessToken ?? apiKey}`,
    Accept: "application/json"
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const response = await fetch(`${url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return parseResponse(response);
}

export function signUp({ email, password, displayName }) {
  return request("/auth/v1/signup", {
    method: "POST",
    body: { email, password, data: { display_name: displayName } }
  });
}

export function signInWithPassword({ email, password }) {
  return request("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email, password }
  });
}

export function refreshSession(refreshToken) {
  return request("/auth/v1/token?grant_type=refresh_token", {
    method: "POST",
    body: { refresh_token: refreshToken }
  });
}

export function getAuthUser(accessToken) {
  return request("/auth/v1/user", { accessToken });
}

export function signOut(accessToken) {
  return request("/auth/v1/logout", { method: "POST", accessToken });
}

export function dbSelect(table, query = "") {
  return request(`/rest/v1/${table}${query ? `?${query}` : ""}`, { serviceRole: true });
}

export function dbInsert(table, body, { upsert = false } = {}) {
  return request(`/rest/v1/${table}`, {
    method: "POST",
    body,
    serviceRole: true,
    prefer: upsert ? "resolution=merge-duplicates,return=representation" : "return=representation"
  });
}

export function dbUpdate(table, query, body) {
  return request(`/rest/v1/${table}?${query}`, {
    method: "PATCH",
    body,
    serviceRole: true,
    prefer: "return=representation"
  });
}

export function dbDelete(table, query) {
  return request(`/rest/v1/${table}?${query}`, {
    method: "DELETE",
    serviceRole: true,
    prefer: "return=representation"
  });
}
