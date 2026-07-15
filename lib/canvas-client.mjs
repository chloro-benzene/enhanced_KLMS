import { readFileSync } from "node:fs";

const CACHE_TTL_MS = 60 * 60 * 1000;
let dashboardCache = null;

export function loadDotEnv() {
  try {
    const text = readFileSync(".env", "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim().replace(/^[\"']|[\"']$/g, "");
      if (!process.env[key]) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

export function getCanvasConfig() {
  loadDotEnv();
  const baseUrl = process.env.CANVAS_BASE_URL;
  const token = process.env.CANVAS_API_TOKEN;
  if (!baseUrl || !token) {
    throw new Error("CANVAS_BASE_URL と CANVAS_API_TOKEN を設定してください。");
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), token };
}

async function canvasFetch(url, config = getCanvasConfig()) {
  const requestUrl = new URL(url);
  const allowedOrigin = new URL(config.baseUrl).origin;
  if (requestUrl.origin !== allowedOrigin) {
    throw new Error("Canvas APIのページ送り先が許可ホストと一致しません。");
  }

  const response = await fetch(requestUrl, {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: "application/json"
    }
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!response.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    throw new Error(`Canvas API error: ${response.status} ${response.statusText}\n${detail}`);
  }

  return { body, nextUrl: getNextUrl(response.headers.get("link")) };
}

function getNextUrl(linkHeader) {
  if (!linkHeader) return null;
  const next = linkHeader.split(",").find((link) => link.includes('rel="next"'));
  return next?.match(/<([^>]+)>/)?.[1] ?? null;
}

export async function canvasGet(path, config = getCanvasConfig()) {
  const { body } = await canvasFetch(`${config.baseUrl}${path}`, config);
  return body;
}

async function canvasGetAll(path, config = getCanvasConfig()) {
  let nextUrl = `${config.baseUrl}${path}`;
  const results = [];
  while (nextUrl) {
    const { body, nextUrl: followingUrl } = await canvasFetch(nextUrl, config);
    if (Array.isArray(body)) results.push(...body);
    else if (body) results.push(body);
    nextUrl = followingUrl;
  }
  return results;
}

async function mapWithLimit(items, limit, task) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await task(items[currentIndex]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function isSubmitted(assignment) {
  const submission = assignment.submission;
  return Boolean(
    assignment.has_submitted_submissions ||
      submission?.submitted_at ||
      submission?.workflow_state === "submitted" ||
      submission?.workflow_state === "graded"
  );
}

function getAssignmentStatus(assignment, now) {
  if (assignment.submitted) return "submitted";
  if (!assignment.dueAt) return "no-due";
  const dueTime = new Date(assignment.dueAt).getTime();
  if (Number.isNaN(dueTime)) return "no-due";
  if (dueTime < now) return "overdue";
  if (dueTime <= now + 7 * 24 * 60 * 60 * 1000) return "due-soon";
  return "upcoming";
}

function getStatusLabel(status) {
  const labels = {
    submitted: "提出済み",
    overdue: "期限切れ",
    "due-soon": "7日以内",
    upcoming: "今後",
    "no-due": "期限なし"
  };
  return labels[status] ?? "未分類";
}

function shouldShowAssignment(assignment, now) {
  if (!assignment.dueAt) return !assignment.submitted;
  const dueTime = new Date(assignment.dueAt).getTime();
  if (Number.isNaN(dueTime)) return !assignment.submitted;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const sixMonthsLater = now + 180 * 24 * 60 * 60 * 1000;
  return !assignment.submitted || (dueTime >= thirtyDaysAgo && dueTime <= sixMonthsLater);
}

function buildStats(assignments) {
  return assignments.reduce(
    (stats, assignment) => {
      stats.total += 1;
      if (assignment.submitted) stats.submitted += 1;
      if (!assignment.submitted) stats.unsubmitted += 1;
      if (assignment.status === "overdue") stats.overdue += 1;
      if (assignment.status === "due-soon") stats.dueSoon += 1;
      if (assignment.status === "no-due") stats.noDue += 1;
      return stats;
    },
    { total: 0, submitted: 0, unsubmitted: 0, overdue: 0, dueSoon: 0, noDue: 0 }
  );
}

async function getCourseAssignments(course, config) {
  try {
    const assignments = await canvasGetAll(
      `/api/v1/courses/${course.id}/assignments?per_page=100&include%5B%5D=submission`,
      config
    );
    return { course, assignments, error: null };
  } catch (error) {
    return { course, assignments: [], error: error.message };
  }
}

function normalizeCourseAssignment(assignment, course, now) {
  const submitted = isSubmitted(assignment);
  const normalized = {
    id: String(assignment.id),
    title: assignment.name ?? "名称なし",
    courseId: String(course.id),
    courseName: course.name,
    dueAt: assignment.due_at ?? null,
    htmlUrl: assignment.html_url ?? "",
    submitted,
    source: "course"
  };
  const status = getAssignmentStatus(normalized, now);
  return { ...normalized, status, statusLabel: getStatusLabel(status) };
}

function normalizeTodoAssignment(item, courseMap, now) {
  const assignment = item.assignment ?? item;
  const courseId = String(
    item.course_id ??
      item.context_code?.replace("course_", "") ??
      assignment.course_id ??
      ""
  );
  const normalized = {
    id: String(assignment.id ?? item.id ?? `${courseId}:${item.html_url ?? item.type}`),
    title: assignment.name ?? item.title ?? "名称なし",
    courseId,
    courseName: item.context_name ?? courseMap.get(courseId)?.name ?? "コース不明",
    dueAt: assignment.due_at ?? item.end_at ?? item.start_at ?? null,
    htmlUrl: item.html_url ?? assignment.html_url ?? "",
    submitted: false,
    source: "todo"
  };
  const status = getAssignmentStatus(normalized, now);
  return { ...normalized, status, statusLabel: getStatusLabel(status) };
}

function normalizeUpcomingAssignment(item, courseMap, now) {
  const assignment = item.assignment ?? item;
  const courseId = String(
    item.context_code?.replace("course_", "") ??
      assignment.course_id ??
      ""
  );
  const normalized = {
    id: String(assignment.id ?? item.id ?? `${courseId}:${item.html_url ?? item.title}`),
    title: item.title ?? assignment.name ?? "名称なし",
    courseId,
    courseName: item.context_name ?? courseMap.get(courseId)?.name ?? "コース不明",
    dueAt: assignment.due_at ?? item.end_at ?? item.start_at ?? null,
    htmlUrl: item.html_url ?? assignment.html_url ?? "",
    submitted: isSubmitted(assignment),
    source: "upcoming"
  };
  const status = getAssignmentStatus(normalized, now);
  return { ...normalized, status, statusLabel: getStatusLabel(status) };
}

function assignmentKey(assignment) {
  return `${assignment.courseId}:${assignment.id}`;
}

function mergeAssignments(baseAssignments, todoItems, upcomingItems, courseMap, now) {
  const merged = new Map();

  for (const assignment of baseAssignments) {
    merged.set(assignmentKey(assignment), assignment);
  }

  for (const item of upcomingItems) {
    const assignment = normalizeUpcomingAssignment(item, courseMap, now);
    if (!assignment.courseId) continue;
    if (!merged.has(assignmentKey(assignment))) {
      merged.set(assignmentKey(assignment), assignment);
    }
  }

  for (const item of todoItems) {
    const assignment = normalizeTodoAssignment(item, courseMap, now);
    if (!assignment.courseId) continue;
    merged.set(assignmentKey(assignment), {
      ...(merged.get(assignmentKey(assignment)) ?? assignment),
      ...assignment,
      submitted: false,
      source: merged.has(assignmentKey(assignment)) ? "course+todo" : "todo"
    });
  }

  return [...merged.values()]
    .filter((assignment) => shouldShowAssignment(assignment, now))
    .sort((a, b) => new Date(a.dueAt ?? 8640000000000000) - new Date(b.dueAt ?? 8640000000000000));
}

export async function buildDashboardData(config = getCanvasConfig()) {
  const fetchedAt = new Date();
  const now = fetchedAt.getTime();
  const [profile, rawCourses, todoItems, upcomingItems] = await Promise.all([
    canvasGet("/api/v1/users/self/profile", config),
    canvasGetAll("/api/v1/courses?enrollment_state=active&per_page=100", config),
    canvasGetAll("/api/v1/users/self/todo?per_page=100", config),
    canvasGetAll("/api/v1/users/self/upcoming_events?type=assignment&per_page=100", config)
  ]);

  const courses = rawCourses.map((course) => ({
    id: String(course.id),
    name: course.name ?? course.course_code ?? "名称なし",
    courseCode: course.course_code ?? "",
    workflowState: course.workflow_state ?? ""
  }));
  const courseMap = new Map(courses.map((course) => [course.id, course]));
  const courseResults = await mapWithLimit(courses, 4, (course) => getCourseAssignments(course, config));
  const fetchErrors = courseResults
    .filter((result) => result.error)
    .map((result) => ({
      courseId: result.course.id,
      courseName: result.course.name,
      message: result.error
    }));

  const courseAssignments = courseResults.flatMap((result) =>
    result.assignments.map((assignment) => normalizeCourseAssignment(assignment, result.course, now))
  );
  const assignments = mergeAssignments(courseAssignments, todoItems, upcomingItems, courseMap, now);

  return {
    profile,
    courses,
    assignments,
    stats: buildStats(assignments),
    meta: {
      fetchedAt: fetchedAt.toISOString(),
      expiresAt: new Date(fetchedAt.getTime() + CACHE_TTL_MS).toISOString(),
      cacheTtlMinutes: CACHE_TTL_MS / 60000,
      cacheSource: "network",
      fetchErrors,
      sourceCounts: {
        courseAssignments: courseAssignments.length,
        todo: todoItems.length,
        upcoming: upcomingItems.length,
        merged: assignments.length
      }
    }
  };
}

function withCacheSource(data, cacheSource) {
  return { ...data, meta: { ...data.meta, cacheSource } };
}

export async function getDashboardData({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && dashboardCache && now < dashboardCache.expiresAt) {
    return withCacheSource(dashboardCache.data, "memory");
  }

  try {
    const data = await buildDashboardData();
    dashboardCache = {
      data,
      expiresAt: new Date(data.meta.expiresAt).getTime()
    };
    return data;
  } catch (error) {
    if (dashboardCache) {
      return {
        ...withCacheSource(dashboardCache.data, "stale"),
        warning: "Canvas APIの更新に失敗したため、前回取得したデータを表示しています。"
      };
    }
    throw error;
  }
}
