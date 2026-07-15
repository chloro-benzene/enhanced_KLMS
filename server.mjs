import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { buildDashboardData, canvasGet, loadDotEnv } from "./lib/canvas-client.mjs";
import {
  SupabaseError,
  dbDelete,
  dbInsert,
  dbSelect,
  dbUpdate,
  getSupabaseConfig,
  signInWithPassword,
  signOut,
  signUp
} from "./lib/supabase.mjs";
import { decryptSecret, encryptSecret, normalizeCanvasBaseUrl, tokenHint } from "./lib/security.mjs";
import {
  HttpError,
  assertMutationRequest,
  assertRateLimit,
  assertUuid,
  cleanText,
  clearSessionCookies,
  getSessionUser,
  readJsonBody,
  setSessionCookies
} from "./lib/http-security.mjs";

loadDotEnv();

const port = Number(process.env.PORT ?? 3000);
const publicDir = resolve(process.cwd(), "public");
const CACHE_TTL_MS = 60 * 60 * 1000;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

function setSecurityHeaders(response) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function sendJson(response, statusCode, data) {
  response.setHeader("Content-Type", contentTypes[".json"]);
  response.setHeader("Cache-Control", "no-store");
  response.statusCode = statusCode;
  response.end(JSON.stringify(data));
}

function clientAddress(request) {
  return String(request.socket.remoteAddress ?? "unknown");
}

function validateCredentials(body) {
  const email = cleanText(body.email, { max: 254, required: true }).toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "メールアドレスの形式が正しくありません。");
  }
  if (!password || password.length > 128) {
    throw new HttpError(400, "パスワードを入力してください。");
  }
  return { email, password };
}

function validateNewPassword(password) {
  if (password.length < 8 || password.length > 128) {
    throw new HttpError(400, "パスワードは8文字以上128文字以内にしてください。");
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new HttpError(400, "パスワードには英字と数字をそれぞれ1文字以上含めてください。");
  }
}

async function ensureProfile(user) {
  const query = `id=eq.${user.id}&select=id,display_name,affiliation,student_number`;
  let rows = await dbSelect("profiles", query);
  if (rows.length === 0) {
    rows = await dbInsert("profiles", {
      id: user.id,
      display_name: user.user_metadata?.display_name ?? "",
      affiliation: "",
      student_number: ""
    }, { upsert: true });
  }
  return rows[0];
}

async function getCanvasSettings(userId) {
  const rows = await dbSelect(
    "canvas_credentials",
    `user_id=eq.${userId}&select=base_url,token_hint,verified_at`
  );
  return rows[0] ?? null;
}

async function getCanvasCredential(userId) {
  const rows = await dbSelect(
    "canvas_credentials",
    `user_id=eq.${userId}&select=base_url,token_ciphertext,token_hint,verified_at`
  );
  return rows[0] ?? null;
}

async function getCachedDashboard(userId) {
  const rows = await dbSelect(
    "canvas_cache",
    `user_id=eq.${userId}&select=payload,fetched_at,expires_at`
  );
  return rows[0] ?? null;
}

function withCacheSource(payload, cacheSource, warning) {
  return {
    ...payload,
    ...(warning ? { warning } : {}),
    meta: { ...payload.meta, cacheSource }
  };
}

async function loadUserDashboard(userId, forceRefresh) {
  const cached = await getCachedDashboard(userId);
  if (!forceRefresh && cached && Date.now() < new Date(cached.expires_at).getTime()) {
    return withCacheSource(cached.payload, "database");
  }

  const credential = await getCanvasCredential(userId);
  if (!credential) {
    throw new HttpError(409, "Canvas API設定を登録してください。", "CANVAS_NOT_CONFIGURED");
  }

  const config = {
    baseUrl: credential.base_url,
    token: decryptSecret(credential.token_ciphertext)
  };

  try {
    const data = await buildDashboardData(config);
    await dbInsert("canvas_cache", {
      user_id: userId,
      payload: data,
      fetched_at: data.meta.fetchedAt,
      expires_at: data.meta.expiresAt
    }, { upsert: true });
    return data;
  } catch (error) {
    if (cached) {
      return withCacheSource(
        cached.payload,
        "stale",
        "Canvas APIの更新に失敗したため、前回取得したデータを表示しています。"
      );
    }
    if (/Canvas API error: 401/.test(error.message)) {
      throw new HttpError(401, "Canvas APIトークンが無効です。API設定を更新してください。", "CANVAS_UNAUTHORIZED");
    }
    throw new HttpError(502, "Canvas APIから情報を取得できませんでした。");
  }
}

const dayToNumber = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const numberToDay = Object.fromEntries(Object.entries(dayToNumber).map(([key, value]) => [value, key]));

function mapTimetableRow(row) {
  return {
    id: row.id,
    day: numberToDay[row.day_of_week],
    period: String(row.period),
    title: row.course_name,
    room: row.room,
    teacher: row.instructor,
    canvasCourseId: row.canvas_course_id,
    memo: row.memo,
    createdAt: row.created_at
  };
}

function mapCampusLink(row, userId) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    category: row.category,
    isGlobal: row.is_global,
    isOwner: row.user_id === userId
  };
}

async function mapTextbookRows(rows, userId) {
  const ids = [...new Set(rows.map((row) => row.user_id))];
  const profiles = ids.length
    ? await dbSelect("profiles", `id=in.(${ids.join(",")})&select=id,display_name`)
    : [];
  const names = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
  return rows.map((row) => ({
    id: row.id,
    type: row.post_type,
    title: row.title,
    course: row.course_name,
    teacher: row.instructor,
    price: row.price,
    condition: row.book_condition,
    campus: row.campus,
    contact: row.contact,
    note: row.note,
    visibility: row.visibility,
    createdAt: row.created_at,
    ownerName: names.get(row.user_id) || "利用者",
    isOwner: row.user_id === userId
  }));
}

async function handleApi(request, response, url) {
  assertMutationRequest(request);
  const method = request.method ?? "GET";

  if (url.pathname === "/api/setup-status" && method === "GET") {
    try {
      getSupabaseConfig();
      sendJson(response, 200, { configured: true });
    } catch {
      sendJson(response, 200, { configured: false });
    }
    return true;
  }

  if (url.pathname === "/api/auth/signup" && method === "POST") {
    assertRateLimit(`signup:${clientAddress(request)}`, { limit: 5 });
    const body = await readJsonBody(request);
    const credentials = validateCredentials(body);
    validateNewPassword(credentials.password);
    const result = await signUp({
      ...credentials,
      displayName: cleanText(body.displayName, { max: 100 })
    });
    if (result.access_token) setSessionCookies(response, result);
    sendJson(response, 201, {
      authenticated: Boolean(result.access_token),
      message: result.access_token
        ? "アカウントを作成しました。"
        : "確認メールを送信しました。メール内のリンクを開いてからログインしてください。"
    });
    return true;
  }

  if (url.pathname === "/api/auth/login" && method === "POST") {
    assertRateLimit(`login:${clientAddress(request)}`, { limit: 10 });
    const credentials = validateCredentials(await readJsonBody(request));
    try {
      const session = await signInWithPassword(credentials);
      setSessionCookies(response, session);
      sendJson(response, 200, { authenticated: true });
    } catch (error) {
      if (error instanceof SupabaseError && error.status < 500) {
        throw new HttpError(401, "メールアドレスまたはパスワードが正しくありません。");
      }
      throw error;
    }
    return true;
  }

  if (url.pathname === "/api/auth/logout" && method === "POST") {
    const session = await getSessionUser(request, response, { required: false });
    if (session) {
      try {
        await signOut(session.accessToken);
      } catch {
        // Cookieは必ず破棄する。
      }
    }
    clearSessionCookies(response);
    sendJson(response, 200, { authenticated: false });
    return true;
  }

  if (url.pathname === "/api/auth/session" && method === "GET") {
    const session = await getSessionUser(request, response, { required: false });
    if (!session) {
      sendJson(response, 200, { authenticated: false });
      return true;
    }
    const [profile, canvasSettings] = await Promise.all([
      ensureProfile(session.user),
      getCanvasSettings(session.user.id)
    ]);
    sendJson(response, 200, {
      authenticated: true,
      user: { id: session.user.id, email: session.user.email },
      profile,
      canvasSettings
    });
    return true;
  }

  const session = await getSessionUser(request, response);
  const userId = session.user.id;

  if (url.pathname === "/api/profile" && method === "PUT") {
    const body = await readJsonBody(request);
    const rows = await dbUpdate("profiles", `id=eq.${userId}`, {
      display_name: cleanText(body.displayName, { max: 100 }),
      affiliation: cleanText(body.affiliation, { max: 150 }),
      student_number: cleanText(body.studentNumber, { max: 50 })
    });
    sendJson(response, 200, rows[0]);
    return true;
  }

  if (url.pathname === "/api/canvas-settings" && method === "GET") {
    sendJson(response, 200, { canvasSettings: await getCanvasSettings(userId) });
    return true;
  }

  if (url.pathname === "/api/canvas-settings" && method === "PUT") {
    assertRateLimit(`canvas:${userId}`, { limit: 10, windowMs: 60 * 60 * 1000 });
    const body = await readJsonBody(request, 16 * 1024);
    const baseUrl = normalizeCanvasBaseUrl(body.baseUrl);
    const token = cleanText(body.token, { max: 512, required: true });
    if (token.length < 20) throw new HttpError(400, "Canvas APIトークンの形式を確認してください。");

    let canvasProfile;
    try {
      canvasProfile = await canvasGet("/api/v1/users/self/profile", { baseUrl, token });
    } catch (error) {
      if (/Canvas API error: 401/.test(error.message)) {
        throw new HttpError(401, "Canvas APIトークンを確認できませんでした。");
      }
      throw new HttpError(502, "Canvas APIへ接続できませんでした。URLを確認してください。");
    }

    const verifiedAt = new Date().toISOString();
    await dbInsert("canvas_credentials", {
      user_id: userId,
      base_url: baseUrl,
      token_ciphertext: encryptSecret(token),
      token_hint: tokenHint(token),
      verified_at: verifiedAt
    }, { upsert: true });
    await dbDelete("canvas_cache", `user_id=eq.${userId}`);
    sendJson(response, 200, {
      canvasSettings: { base_url: baseUrl, token_hint: tokenHint(token), verified_at: verifiedAt },
      canvasProfile: { name: canvasProfile.name ?? "" }
    });
    return true;
  }

  if (url.pathname === "/api/canvas-settings" && method === "DELETE") {
    await Promise.all([
      dbDelete("canvas_credentials", `user_id=eq.${userId}`),
      dbDelete("canvas_cache", `user_id=eq.${userId}`)
    ]);
    sendJson(response, 200, { deleted: true });
    return true;
  }

  if (url.pathname === "/api/dashboard" && method === "GET") {
    const data = await loadUserDashboard(userId, url.searchParams.get("refresh") === "1");
    sendJson(response, 200, data);
    return true;
  }

  if (url.pathname === "/api/timetable" && method === "GET") {
    const rows = await dbSelect(
      "timetable_entries",
      `user_id=eq.${userId}&select=*&order=day_of_week.asc,period.asc,created_at.asc`
    );
    sendJson(response, 200, { entries: rows.map(mapTimetableRow) });
    return true;
  }

  if (url.pathname === "/api/timetable" && method === "POST") {
    const body = await readJsonBody(request);
    const day = dayToNumber[body.day];
    const period = Number(body.period);
    if (!day || !Number.isInteger(period) || period < 1 || period > 7) {
      throw new HttpError(400, "曜日または時限が正しくありません。");
    }
    const rows = await dbInsert("timetable_entries", {
      user_id: userId,
      day_of_week: day,
      period,
      course_name: cleanText(body.title, { max: 200, required: true }),
      room: cleanText(body.room, { max: 100 }),
      instructor: cleanText(body.teacher, { max: 100 }),
      canvas_course_id: cleanText(body.canvasCourseId, { max: 100 }) || null,
      memo: cleanText(body.memo, { max: 1000 })
    });
    sendJson(response, 201, mapTimetableRow(rows[0]));
    return true;
  }

  const timetableMatch = url.pathname.match(/^\/api\/timetable\/([0-9a-f-]+)$/i);
  if (timetableMatch && method === "DELETE") {
    const id = assertUuid(timetableMatch[1]);
    await dbDelete("timetable_entries", `id=eq.${id}&user_id=eq.${userId}`);
    sendJson(response, 200, { deleted: true });
    return true;
  }

  if (url.pathname === "/api/campus-links" && method === "GET") {
    const rows = await dbSelect(
      "campus_links",
      `or=(is_global.eq.true,user_id.eq.${userId})&select=*&order=is_global.desc,sort_order.asc,created_at.asc`
    );
    sendJson(response, 200, { links: rows.map((row) => mapCampusLink(row, userId)) });
    return true;
  }

  if (url.pathname === "/api/campus-links" && method === "POST") {
    const body = await readJsonBody(request);
    const rawUrl = cleanText(body.url, { max: 2048, required: true });
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new HttpError(400, "URLの形式が正しくありません。");
    }
    if (parsed.protocol !== "https:") throw new HttpError(400, "リンクはHTTPSで登録してください。");
    const rows = await dbInsert("campus_links", {
      user_id: userId,
      name: cleanText(body.name, { max: 100, required: true }),
      url: parsed.toString(),
      category: "personal",
      is_global: false
    });
    sendJson(response, 201, mapCampusLink(rows[0], userId));
    return true;
  }

  const campusMatch = url.pathname.match(/^\/api\/campus-links\/([0-9a-f-]+)$/i);
  if (campusMatch && method === "DELETE") {
    const id = assertUuid(campusMatch[1]);
    await dbDelete("campus_links", `id=eq.${id}&user_id=eq.${userId}&is_global=eq.false`);
    sendJson(response, 200, { deleted: true });
    return true;
  }

  if (url.pathname === "/api/textbooks" && method === "GET") {
    const rows = await dbSelect(
      "textbook_posts",
      `or=(visibility.eq.published,user_id.eq.${userId})&select=*&order=created_at.desc&limit=200`
    );
    sendJson(response, 200, { posts: await mapTextbookRows(rows, userId) });
    return true;
  }

  if (url.pathname === "/api/textbooks" && method === "POST") {
    const body = await readJsonBody(request);
    if (!["sell", "buy"].includes(body.type)) throw new HttpError(400, "投稿種別が正しくありません。");
    const rows = await dbInsert("textbook_posts", {
      user_id: userId,
      post_type: body.type,
      title: cleanText(body.title, { max: 200, required: true }),
      course_name: cleanText(body.course, { max: 200 }),
      instructor: cleanText(body.teacher, { max: 100 }),
      price: cleanText(body.price, { max: 100 }),
      book_condition: cleanText(body.condition, { max: 100 }),
      campus: cleanText(body.campus, { max: 100 }),
      contact: cleanText(body.contact, { max: 300 }),
      note: cleanText(body.note, { max: 1000 }),
      visibility: "published"
    });
    sendJson(response, 201, (await mapTextbookRows(rows, userId))[0]);
    return true;
  }

  const textbookMatch = url.pathname.match(/^\/api\/textbooks\/([0-9a-f-]+)$/i);
  if (textbookMatch && method === "DELETE") {
    const id = assertUuid(textbookMatch[1]);
    await dbDelete("textbook_posts", `id=eq.${id}&user_id=eq.${userId}`);
    sendJson(response, 200, { deleted: true });
    return true;
  }

  if (url.pathname === "/api/report-template" && method === "GET") {
    const rows = await dbSelect(
      "report_templates",
      `user_id=eq.${userId}&is_default=eq.true&select=*&limit=1`
    );
    sendJson(response, 200, { template: rows[0] ?? null });
    return true;
  }

  if (url.pathname === "/api/report-template" && method === "PUT") {
    const body = await readJsonBody(request);
    const existing = await dbSelect(
      "report_templates",
      `user_id=eq.${userId}&is_default=eq.true&select=id&limit=1`
    );
    const values = {
      name: cleanText(body.name, { max: 100 }) || "標準",
      full_name: cleanText(body.fullName, { max: 100 }),
      student_number: cleanText(body.studentNumber, { max: 50 }),
      faculty: cleanText(body.faculty, { max: 100 }),
      department: cleanText(body.department, { max: 100 }),
      cover_fields: typeof body.coverFields === "object" && body.coverFields ? body.coverFields : {},
      submission_format: typeof body.submissionFormat === "object" && body.submissionFormat ? body.submissionFormat : {},
      is_default: true
    };
    const rows = existing[0]
      ? await dbUpdate("report_templates", `id=eq.${existing[0].id}&user_id=eq.${userId}`, values)
      : await dbInsert("report_templates", { ...values, user_id: userId });
    sendJson(response, 200, { template: rows[0] });
    return true;
  }

  return false;
}

async function serveStatic(request, response) {
  const url = new URL(request.url ?? "/", `http://localhost:${port}`);
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1));
  const filePath = resolve(publicDir, requestedPath);

  if (filePath !== publicDir && !filePath.startsWith(publicDir + sep)) {
    throw new HttpError(403, "Forbidden");
  }

  const content = await readFile(filePath);
  response.setHeader("Content-Type", contentTypes[extname(filePath)] ?? "application/octet-stream");
  response.setHeader("Cache-Control", extname(filePath) === ".html" ? "no-cache" : "public, max-age=300");
  response.statusCode = 200;
  response.end(content);
}

const server = createServer(async (request, response) => {
  setSecurityHeaders(response);
  try {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(request, response, url);
      if (!handled) sendJson(response, 404, { message: "APIが見つかりません。" });
      return;
    }
    await serveStatic(request, response);
  } catch (error) {
    const status = error instanceof HttpError
      ? error.status
      : error instanceof SupabaseError && error.status < 500
        ? 400
        : 500;
    const message = status >= 500
      ? "サーバーで処理できませんでした。設定または接続状況を確認してください。"
      : error.message;
    if (request.url?.startsWith("/api/")) {
      sendJson(response, status, { message, code: error.code ?? "REQUEST_FAILED" });
      return;
    }
    response.statusCode = status === 403 ? 403 : 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end(status === 403 ? "Forbidden" : "Not Found");
  }
});

server.listen(port, () => {
  console.log(`強化版K-LMS を起動しました: http://localhost:${port}`);
});
