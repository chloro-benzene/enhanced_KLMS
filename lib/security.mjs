import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function getEncryptionKey() {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("TOKEN_ENCRYPTION_KEY は32バイトのBase64値で設定してください。");
  }
  return key;
}

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function decryptSecret(payload) {
  const [version, ivText, tagText, encryptedText] = String(payload).split(".");
  if (version !== "v1" || !ivText || !tagText || !encryptedText) {
    throw new Error("暗号化済みトークンの形式が不正です。");
  }
  const decipher = createDecipheriv("aes-256-gcm", getEncryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedText, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function normalizeCanvasBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error("Canvas URLの形式が正しくありません。");
  }

  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("Canvas URLにはHTTPSのホスト名だけを指定してください。");
  }

  const allowedHosts = (process.env.CANVAS_ALLOWED_HOSTS ?? "lms.keio.jp")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!allowedHosts.includes(url.hostname.toLowerCase())) {
    throw new Error(`許可されていないCanvasホストです。許可対象: ${allowedHosts.join(", ")}`);
  }

  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function tokenHint(token) {
  const value = String(token);
  return value.length <= 8 ? "設定済み" : `末尾 ${value.slice(-4)}`;
}
