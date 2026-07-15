const $ = (selector) => document.querySelector(selector);

const setupWarning = $("#setup-warning");
const authView = $("#auth-view");
const appView = $("#app-view");
const authMessage = $("#auth-message");
const loginForm = $("#login-form");
const signupForm = $("#signup-form");
const logoutButton = $("#logout");
const profileForm = $("#profile-form");
const canvasSettingsForm = $("#canvas-settings-form");
const canvasSettingStatus = $("#canvas-setting-status");
const deleteCanvasSettingsButton = $("#delete-canvas-settings");
const profileLabel = $("#profile");
const cacheSummary = $("#cache-summary");
const reloadButton = $("#reload");
const refreshButton = $("#refresh");
const assignments = $("#assignments");
const courses = $("#courses");
const assignmentCount = $("#assignment-count");
const courseCount = $("#course-count");
const courseFilter = $("#course-filter");
const statusFilter = $("#status-filter");
const campusLinks = $("#campus-links");
const transportLinks = $("#transport-links");
const campusLinkForm = $("#campus-link-form");
const textbookForm = $("#textbook-form");
const textbookPosts = $("#textbook-posts");
const textbookSearch = $("#textbook-search");
const textbookFilterType = $("#textbook-filter-type");
const timetableForm = $("#timetable-form");
const todayClasses = $("#today-classes");
const weeklyTimetable = $("#weekly-timetable");
const courseOptions = $("#course-options");
const toast = $("#toast");

const defaultCampusLinks = [
  { name: "K-LMS", url: "https://lms.keio.jp" },
  { name: "keio.jp", url: "https://keio.jp" },
  { name: "慶應義塾 公式サイト", url: "https://www.keio.ac.jp/ja/" },
  { name: "在学生向け情報", url: "https://www.students.keio.ac.jp/" },
  { name: "ITC", url: "https://www.itc.keio.ac.jp/ja/" },
  { name: "メディアセンター", url: "https://www.lib.keio.ac.jp/" }
];

const defaultTransportLinks = [
  { name: "JR東日本 運行情報", url: "https://traininfo.jreast.co.jp/train_info/kanto.aspx" },
  { name: "東急線 運行情報", url: "https://www.tokyu.co.jp/unten2/unten.html" },
  { name: "東京メトロ 運行情報", url: "https://www.tokyometro.jp/unkou/" },
  { name: "Yahoo! 路線情報", url: "https://transit.yahoo.co.jp/diainfo/area/4" }
];

const timetableDays = [
  { key: "mon", label: "月" },
  { key: "tue", label: "火" },
  { key: "wed", label: "水" },
  { key: "thu", label: "木" },
  { key: "fri", label: "金" },
  { key: "sat", label: "土" }
];
const timetablePeriods = ["1", "2", "3", "4", "5", "6"];

let sessionState = null;
let dashboardData = null;
let timetableEntries = [];
let customCampusLinks = [];
let textbookPostList = [];
let toastTimer = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeWebUrl(value) {
  try {
    const url = new URL(String(value));
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function formatDate(value) {
  if (!value) return "期限なし";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "未取得";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function getValue(selector) {
  return $(selector).value.trim();
}

function showToast(message, type = "success") {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4000);
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) headers["X-KLMS-CSRF"] = "1";
  const response = await fetch(path, {
    method,
    headers,
    credentials: "same-origin",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message ?? "処理に失敗しました。");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function setFormBusy(form, busy) {
  for (const control of form.elements) control.disabled = busy;
}

function showAuth() {
  sessionState = null;
  dashboardData = null;
  appView.hidden = true;
  authView.hidden = false;
}

function fillAccountSettings() {
  const userProfile = sessionState.profile ?? {};
  $("#profile-name").value = userProfile.display_name ?? "";
  $("#profile-affiliation").value = userProfile.affiliation ?? "";
  $("#profile-student-number").value = userProfile.student_number ?? "";
  profileLabel.textContent = `${userProfile.display_name || sessionState.user.email} のCanvas情報`;

  const setting = sessionState.canvasSettings;
  canvasSettingStatus.textContent = setting
    ? `設定済み（${setting.token_hint}、確認: ${formatDateTime(setting.verified_at)}）`
    : "未設定";
  deleteCanvasSettingsButton.hidden = !setting;
  if (setting?.base_url) $("#canvas-base-url").value = setting.base_url;
  $("#canvas-token").value = "";
}

async function showApplication(session) {
  sessionState = session;
  authView.hidden = true;
  appView.hidden = false;
  fillAccountSettings();
  await migratePrivateLocalData();
  await Promise.allSettled([
    loadDashboard(),
    loadTimetable(),
    loadCampusLinks(),
    loadTextbooks()
  ]);
}

async function refreshSession() {
  const result = await api("/api/auth/session");
  if (!result.authenticated) {
    showAuth();
    return;
  }
  await showApplication(result);
}

async function initialize() {
  try {
    const setup = await api("/api/setup-status");
    setupWarning.hidden = setup.configured;
    if (!setup.configured) {
      showAuth();
      for (const form of [loginForm, signupForm]) setFormBusy(form, true);
      return;
    }
    await refreshSession();
  } catch (error) {
    setupWarning.hidden = false;
    setupWarning.textContent = error.message;
    showAuth();
  }
}

async function handleLogin(event) {
  event.preventDefault();
  authMessage.textContent = "";
  setFormBusy(loginForm, true);
  try {
    await api("/api/auth/login", {
      method: "POST",
      body: { email: getValue("#login-email"), password: $("#login-password").value }
    });
    loginForm.reset();
    await refreshSession();
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    setFormBusy(loginForm, false);
  }
}

async function handleSignup(event) {
  event.preventDefault();
  authMessage.textContent = "";
  setFormBusy(signupForm, true);
  try {
    const result = await api("/api/auth/signup", {
      method: "POST",
      body: {
        displayName: getValue("#signup-name"),
        email: getValue("#signup-email"),
        password: $("#signup-password").value
      }
    });
    signupForm.reset();
    authMessage.textContent = result.message;
    if (result.authenticated) await refreshSession();
  } catch (error) {
    authMessage.textContent = error.message;
  } finally {
    setFormBusy(signupForm, false);
  }
}

async function handleLogout() {
  await api("/api/auth/logout", { method: "POST" });
  showAuth();
  showToast("ログアウトしました。");
}

async function saveProfile(event) {
  event.preventDefault();
  setFormBusy(profileForm, true);
  try {
    const userProfile = await api("/api/profile", {
      method: "PUT",
      body: {
        displayName: getValue("#profile-name"),
        affiliation: getValue("#profile-affiliation"),
        studentNumber: getValue("#profile-student-number")
      }
    });
    sessionState.profile = userProfile;
    fillAccountSettings();
    showToast("ユーザー情報を保存しました。");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setFormBusy(profileForm, false);
  }
}

async function saveCanvasSettings(event) {
  event.preventDefault();
  setFormBusy(canvasSettingsForm, true);
  canvasSettingStatus.textContent = "Canvasへ接続して確認しています。";
  try {
    const result = await api("/api/canvas-settings", {
      method: "PUT",
      body: {
        baseUrl: getValue("#canvas-base-url"),
        token: $("#canvas-token").value.trim()
      }
    });
    sessionState.canvasSettings = result.canvasSettings;
    fillAccountSettings();
    showToast(`${result.canvasProfile.name || "Canvasユーザー"}として接続しました。`);
    await loadDashboard({ refresh: true });
  } catch (error) {
    fillAccountSettings();
    showToast(error.message, "error");
  } finally {
    setFormBusy(canvasSettingsForm, false);
  }
}

async function deleteCanvasSettings() {
  if (!confirm("Canvas API設定と保存済みキャッシュを削除しますか？")) return;
  try {
    await api("/api/canvas-settings", { method: "DELETE" });
    sessionState.canvasSettings = null;
    dashboardData = null;
    fillAccountSettings();
    resetDashboard("Canvas APIを設定してください。");
    showToast("Canvas API設定を削除しました。");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function resetDashboard(message) {
  $("#stat-overdue").textContent = "0";
  $("#stat-due-soon").textContent = "0";
  $("#stat-unsubmitted").textContent = "0";
  $("#stat-submitted").textContent = "0";
  assignments.innerHTML = `<p class="empty">${escapeHtml(message)}</p>`;
  courses.innerHTML = '<p class="empty">表示できるコースがありません。</p>';
  assignmentCount.textContent = "0件";
  courseCount.textContent = "0件";
  cacheSummary.textContent = message;
  courseOptions.innerHTML = "";
}

function updateCacheSummary(meta, warning) {
  const sourceLabels = {
    network: "Canvasから取得",
    database: "1時間キャッシュを表示",
    stale: "前回のキャッシュを表示"
  };
  const sourceCountNote = meta.sourceCounts
    ? `課題API ${meta.sourceCounts.courseAssignments}件 / To Do ${meta.sourceCounts.todo}件 / 表示対象 ${meta.sourceCounts.merged}件`
    : "";
  cacheSummary.textContent = [
    sourceLabels[meta.cacheSource] ?? "取得済み",
    `取得: ${formatDateTime(meta.fetchedAt)}`,
    `有効期限: ${formatDateTime(meta.expiresAt)}`,
    sourceCountNote,
    meta.fetchErrors?.length ? `一部取得失敗: ${meta.fetchErrors.length}件` : "",
    warning
  ].filter(Boolean).join(" / ");
}

function getFilteredAssignments() {
  if (!dashboardData) return [];
  return dashboardData.assignments.filter((assignment) => {
    const courseMatches = courseFilter.value === "all" || assignment.courseId === courseFilter.value;
    const statusMatches =
      statusFilter.value === "all" ||
      (statusFilter.value === "unsubmitted" && !assignment.submitted) ||
      assignment.status === statusFilter.value;
    return courseMatches && statusMatches;
  });
}

function renderAssignments() {
  const items = getFilteredAssignments();
  const total = dashboardData?.assignments.length ?? 0;
  assignmentCount.textContent = `${items.length}件表示 / 全${total}件`;
  if (items.length === 0) {
    assignments.innerHTML = '<p class="empty">条件に合う課題はありません。</p>';
    return;
  }
  assignments.innerHTML = items.map((item) => {
    const title = escapeHtml(item.title);
    const itemUrl = safeWebUrl(item.htmlUrl);
    const link = itemUrl
      ? `<a href="${escapeHtml(itemUrl)}" target="_blank" rel="noreferrer">${title}</a>`
      : title;
    return `<div class="item">
      <div class="item-title">${link}<span class="badge status-${escapeHtml(item.status)}">${escapeHtml(item.statusLabel)}</span></div>
      <div class="meta">${escapeHtml(item.courseName ?? "コース不明")}・${formatDate(item.dueAt)}</div>
    </div>`;
  }).join("");
}

function renderCourses() {
  const items = dashboardData?.courses ?? [];
  courseCount.textContent = `${items.length}件`;
  if (items.length === 0) {
    courses.innerHTML = '<p class="empty">履修中コースはありません。</p>';
    return;
  }
  const counts = new Map();
  for (const assignment of dashboardData.assignments) {
    if (!assignment.submitted) {
      counts.set(assignment.courseId, (counts.get(assignment.courseId) ?? 0) + 1);
    }
  }
  courses.innerHTML = items.map((course) => `<div class="item">
    <div class="item-title">${escapeHtml(course.name)}</div>
    <div class="meta">${escapeHtml(course.courseCode || `course_id=${course.id}`)}・${counts.get(course.id) ? `未提出 ${counts.get(course.id)}件` : "未提出なし"}</div>
  </div>`).join("");
}

function renderDashboard() {
  const stats = dashboardData.stats;
  $("#stat-overdue").textContent = stats.overdue;
  $("#stat-due-soon").textContent = stats.dueSoon;
  $("#stat-unsubmitted").textContent = stats.unsubmitted;
  $("#stat-submitted").textContent = stats.submitted;
  const current = courseFilter.value;
  courseFilter.innerHTML = '<option value="all">全科目</option>' + dashboardData.courses
    .map((course) => `<option value="${escapeHtml(course.id)}">${escapeHtml(course.name)}</option>`)
    .join("");
  if ([...courseFilter.options].some((option) => option.value === current)) {
    courseFilter.value = current;
  }
  courseOptions.innerHTML = dashboardData.courses
    .map((course) => `<option value="${escapeHtml(course.name)}"></option>`)
    .join("");
  renderAssignments();
  renderCourses();
}

async function loadDashboard({ refresh = false } = {}) {
  if (!sessionState?.canvasSettings) {
    resetDashboard("Canvas APIを設定してください。");
    return;
  }
  reloadButton.disabled = true;
  refreshButton.disabled = true;
  assignments.innerHTML = '<p class="empty">読み込み中です。</p>';
  courses.innerHTML = '<p class="empty">読み込み中です。</p>';
  try {
    dashboardData = await api(refresh ? "/api/dashboard?refresh=1" : "/api/dashboard");
    updateCacheSummary(dashboardData.meta, dashboardData.warning);
    renderDashboard();
  } catch (error) {
    dashboardData = null;
    resetDashboard(error.message);
    if (error.code === "CANVAS_UNAUTHORIZED") {
      canvasSettingStatus.textContent = "再設定が必要です";
    }
  } finally {
    reloadButton.disabled = false;
    refreshButton.disabled = false;
  }
}

function getTodayKey() {
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date().getDay()];
}

function sortTimetable(items) {
  const order = new Map(timetableDays.map((day, index) => [day.key, index]));
  return [...items].sort(
    (a, b) => (order.get(a.day) - order.get(b.day)) || Number(a.period) - Number(b.period)
  );
}

function renderTimetable() {
  const todays = sortTimetable(timetableEntries.filter((entry) => entry.day === getTodayKey()));
  todayClasses.innerHTML = todays.length
    ? todays.map((entry) => `<div class="today-class">
        <strong>${escapeHtml(entry.period)}限 ${escapeHtml(entry.title)}</strong>
        <span>${escapeHtml([entry.room, entry.teacher].filter(Boolean).join("・") || "詳細未入力")}</span>
      </div>`).join("")
    : '<p class="empty compact-empty">今日登録されている授業はありません。</p>';

  const cells = new Map();
  for (const entry of timetableEntries) {
    const key = `${entry.day}:${entry.period}`;
    cells.set(key, [...(cells.get(key) ?? []), entry]);
  }
  const header = ['<div class="timetable-corner">時限</div>']
    .concat(timetableDays.map((day) => `<div class="timetable-head">${day.label}</div>`))
    .join("");
  const rows = timetablePeriods.map((period) => {
    const row = timetableDays.map((day) => {
      const entries = cells.get(`${day.key}:${period}`) ?? [];
      const cell = entries.length
        ? entries.map((entry) => `<div class="timetable-entry">
            <strong>${escapeHtml(entry.title)}</strong>
            <span>${escapeHtml([entry.room, entry.teacher].filter(Boolean).join("・"))}</span>
            ${entry.memo ? `<p>${escapeHtml(entry.memo)}</p>` : ""}
            <button type="button" class="text-button danger-text" data-timetable-id="${escapeHtml(entry.id)}">削除</button>
          </div>`).join("")
        : '<span class="timetable-empty">-</span>';
      return `<div class="timetable-cell">${cell}</div>`;
    }).join("");
    return `<div class="timetable-period">${period}限</div>${row}`;
  }).join("");
  weeklyTimetable.innerHTML = header + rows;
}

async function loadTimetable() {
  const data = await api("/api/timetable");
  timetableEntries = data.entries;
  renderTimetable();
}

async function addTimetableEntry(event) {
  event.preventDefault();
  setFormBusy(timetableForm, true);
  try {
    const entry = await api("/api/timetable", {
      method: "POST",
      body: {
        day: getValue("#timetable-day"),
        period: getValue("#timetable-period"),
        title: getValue("#timetable-title"),
        room: getValue("#timetable-room"),
        teacher: getValue("#timetable-teacher"),
        memo: getValue("#timetable-memo")
      }
    });
    timetableEntries = sortTimetable([...timetableEntries, entry]);
    timetableForm.reset();
    renderTimetable();
    showToast("時間割に追加しました。");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setFormBusy(timetableForm, false);
  }
}

async function deleteTimetableEntry(id) {
  try {
    await api(`/api/timetable/${encodeURIComponent(id)}`, { method: "DELETE" });
    timetableEntries = timetableEntries.filter((entry) => entry.id !== id);
    renderTimetable();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function renderLinkList(container, links) {
  container.innerHTML = links.map((link) => {
    const url = safeWebUrl(link.url);
    return `<div class="quick-link">
      <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(link.name)}</a>
      ${link.isOwner ? `<button type="button" class="text-button danger-text" data-campus-id="${escapeHtml(link.id)}">削除</button>` : ""}
    </div>`;
  }).join("");
}

function renderCampusHub() {
  renderLinkList(campusLinks, [...defaultCampusLinks, ...customCampusLinks]);
  renderLinkList(transportLinks, defaultTransportLinks);
}

async function loadCampusLinks() {
  const data = await api("/api/campus-links");
  customCampusLinks = data.links;
  renderCampusHub();
}

async function addCampusLink(event) {
  event.preventDefault();
  setFormBusy(campusLinkForm, true);
  try {
    const link = await api("/api/campus-links", {
      method: "POST",
      body: { name: getValue("#campus-link-name"), url: getValue("#campus-link-url") }
    });
    customCampusLinks.push(link);
    campusLinkForm.reset();
    renderCampusHub();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setFormBusy(campusLinkForm, false);
  }
}

async function deleteCampusLink(id) {
  try {
    await api(`/api/campus-links/${encodeURIComponent(id)}`, { method: "DELETE" });
    customCampusLinks = customCampusLinks.filter((link) => link.id !== id);
    renderCampusHub();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function getFilteredTextbooks() {
  const query = textbookSearch.value.trim().toLowerCase();
  return textbookPostList.filter((post) => {
    const typeMatches = textbookFilterType.value === "all" || post.type === textbookFilterType.value;
    const text = [post.title, post.course, post.teacher, post.campus, post.note].join(" ").toLowerCase();
    return typeMatches && (!query || text.includes(query));
  });
}

function renderTextbooks() {
  const posts = getFilteredTextbooks();
  if (posts.length === 0) {
    textbookPosts.innerHTML = '<p class="empty">まだ投稿がありません。</p>';
    return;
  }
  textbookPosts.innerHTML = posts.map((post) => {
    const typeLabel = post.type === "sell" ? "売りたい" : "買いたい";
    const details = [post.course, post.teacher, post.campus, post.price, post.condition]
      .filter(Boolean).map(escapeHtml).join("・");
    return `<div class="item textbook-post">
      <div class="item-title">
        <span>${escapeHtml(post.title)}</span>
        <span class="badge ${post.type === "sell" ? "status-upcoming" : "status-due-soon"}">${typeLabel}</span>
      </div>
      <div class="meta">${details || "詳細未入力"}・投稿者: ${escapeHtml(post.ownerName)}</div>
      ${post.contact ? `<div class="meta">連絡先: ${escapeHtml(post.contact)}</div>` : ""}
      ${post.note ? `<p class="post-note">${escapeHtml(post.note)}</p>` : ""}
      ${post.isOwner ? `<button type="button" class="text-button danger-text" data-post-id="${escapeHtml(post.id)}">削除</button>` : ""}
    </div>`;
  }).join("");
}

async function loadTextbooks() {
  const data = await api("/api/textbooks");
  textbookPostList = data.posts;
  renderTextbooks();
}

async function addTextbookPost(event) {
  event.preventDefault();
  setFormBusy(textbookForm, true);
  try {
    const post = await api("/api/textbooks", {
      method: "POST",
      body: {
        type: getValue("#textbook-type"),
        campus: getValue("#textbook-campus"),
        title: getValue("#textbook-title"),
        course: getValue("#textbook-course"),
        teacher: getValue("#textbook-teacher"),
        price: getValue("#textbook-price"),
        condition: getValue("#textbook-condition"),
        contact: getValue("#textbook-contact"),
        note: getValue("#textbook-note")
      }
    });
    textbookPostList = [post, ...textbookPostList];
    textbookForm.reset();
    renderTextbooks();
    showToast("教科書情報を投稿しました。");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    setFormBusy(textbookForm, false);
  }
}

async function deleteTextbookPost(id) {
  try {
    await api(`/api/textbooks/${encodeURIComponent(id)}`, { method: "DELETE" });
    textbookPostList = textbookPostList.filter((post) => post.id !== id);
    renderTextbooks();
  } catch (error) {
    showToast(error.message, "error");
  }
}

function readLegacy(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]");
  } catch {
    return [];
  }
}

async function migratePrivateLocalData() {
  const marker = `enhancedKLMS.dbMigration.${sessionState.user.id}`;
  if (localStorage.getItem(marker)) return;
  const legacyTimetable = readLegacy("enhancedKLMS.timetableEntries");
  const legacyLinks = readLegacy("enhancedKLMS.campusLinks");
  for (const entry of legacyTimetable.slice(0, 100)) {
    await api("/api/timetable", { method: "POST", body: entry }).catch(() => {});
  }
  for (const link of legacyLinks.slice(0, 100)) {
    await api("/api/campus-links", { method: "POST", body: link }).catch(() => {});
  }
  localStorage.setItem(marker, "1");
}

loginForm.addEventListener("submit", handleLogin);
signupForm.addEventListener("submit", handleSignup);
logoutButton.addEventListener("click", handleLogout);
profileForm.addEventListener("submit", saveProfile);
canvasSettingsForm.addEventListener("submit", saveCanvasSettings);
deleteCanvasSettingsButton.addEventListener("click", deleteCanvasSettings);
reloadButton.addEventListener("click", () => loadDashboard());
refreshButton.addEventListener("click", () => loadDashboard({ refresh: true }));
courseFilter.addEventListener("change", renderAssignments);
statusFilter.addEventListener("change", renderAssignments);
timetableForm.addEventListener("submit", addTimetableEntry);
weeklyTimetable.addEventListener("click", (event) => {
  const button = event.target.closest("[data-timetable-id]");
  if (button) deleteTimetableEntry(button.dataset.timetableId);
});
campusLinkForm.addEventListener("submit", addCampusLink);
campusLinks.addEventListener("click", (event) => {
  const button = event.target.closest("[data-campus-id]");
  if (button) deleteCampusLink(button.dataset.campusId);
});
textbookForm.addEventListener("submit", addTextbookPost);
textbookSearch.addEventListener("input", renderTextbooks);
textbookFilterType.addEventListener("change", renderTextbooks);
textbookPosts.addEventListener("click", (event) => {
  const button = event.target.closest("[data-post-id]");
  if (button) deleteTextbookPost(button.dataset.postId);
});

renderCampusHub();
renderTimetable();
initialize();
