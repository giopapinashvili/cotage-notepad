"use strict";
const $ = (id) => document.getElementById(id);
const FIELDS = [
  "start_date",
  "end_date",
  "start_time",
  "end_time",
  "status",
  "guests",
  "price",
  "deposit",
  "guest_name",
  "phone",
  "notes"
];
const LABELS = {
  start_date: "შესვლა",
  end_date: "გასვლა",
  start_time: "შესვლის საათი",
  end_time: "გასვლის საათი",
  status: "სტატუსი",
  guests: "სტუმრები",
  price: "სრული ფასი",
  deposit: "ავანსი",
  guest_name: "სტუმრის სახელი",
  phone: "ტელეფონი",
  notes: "ჩანაწერი"
};
const STATUS = {
  confirmed: "დაჯავშნილია",
  hold: "დადასტურებას ველოდებით",
  blocked: "ჩვენთვის დაკავებულია",
  cancelled: "გაუქმებულია"
};
const MONTHS = [
  "იანვარი",
  "თებერვალი",
  "მარტი",
  "აპრილი",
  "მაისი",
  "ივნისი",
  "ივლისი",
  "აგვისტო",
  "სექტემბერი",
  "ოქტომბერი",
  "ნოემბერი",
  "დეკემბერი"
];
const WEEKDAYS = [
  "კვირა",
  "ორშაბათი",
  "სამშაბათი",
  "ოთხშაბათი",
  "ხუთშაბათი",
  "პარასკევი",
  "შაბათი"
];
const state = {
  config: {},
  // null until this browser saves something; then the browser notebook or a
  // signed-up account (see /api/session).
  session: null,
  memberRequired: false,
  mergeAsked: false,
  snapshotWaiters: [],
  bookings: new Map(),
  drafts: new Map(),
  presence: [],
  month: today().slice(0, 7),
  openId: null,
  connected: false,
  ws: null,
  retry: 0,
  retryTimer: null,
  requests: new Map(),
  editingId: null,
  editorReady: false,
  dirty: {},
  pendingPatch: {},
  patchTimer: null,
  patchDrain: null,
  editorEpoch: 0,
  editorBusy: null,
  recovery: [],
  resumePending: false,
  firstSnapshot: true,
  connecting: false,
  connectionAttempt: 0
};
let deferredInstall,
  installPromptAttempted = false,
  installGuidanceShown = false,
  toastTimer,
  registration,
  confirmResolve,
  lastPong = 0,
  updateReloadPending = false;
function today() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tbilisi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}
function esc(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]
  );
}
function isDate(value) {
  if (typeof value !== "string" || !/^20\d\d-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(value + "T00:00:00.000Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
function dateLabel(date, weekday = false) {
  if (!isDate(date)) return "თარიღი დასაზუსტებელია";
  const value = new Date(date + "T12:00:00Z");
  return (
    value.getUTCDate() +
    " " +
    MONTHS[value.getUTCMonth()] +
    (weekday ? ", " + WEEKDAYS[value.getUTCDay()] : "")
  );
}
function rangeLabel(data) {
  return data.start_date === data.end_date
    ? dateLabel(data.start_date)
    : `${dateLabel(data.start_date)} — ${dateLabel(data.end_date)}`;
}
function shortTime(ts) {
  const value = new Date(ts + 4 * 3600000);
  return (
    value.getUTCDate() +
    " " +
    MONTHS[value.getUTCMonth()] +
    " · " +
    String(value.getUTCHours()).padStart(2, "0") +
    ":" +
    String(value.getUTCMinutes()).padStart(2, "0")
  );
}
function money(value) {
  if (value === "" || value == null || !Number.isFinite(Number(value)))
    return "—";
  return `${new Intl.NumberFormat("ka-GE", { maximumFractionDigits: 2 }).format(Number(value))} ₾`;
}
function registered() {
  return Boolean(state.session && !state.session.account.guest);
}
// The name under which this device writes (empty for a browser notebook).
function myName() {
  return state.session?.member?.name || "";
}
function personTone(name) {
  let hash = 0;
  for (const char of String(name)) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return "person-" + (hash % 6);
}
function personChip(name, extra = "") {
  const initial = [...String(name).trim()][0] || "?";
  return `<span class="person-chip ${personTone(name)} ${extra}"><span class="person-initial" aria-hidden="true">${esc(initial)}</span>${esc(name)}</span>`;
}
function placeToast() {
  const target =
    Array.from(document.querySelectorAll("dialog[open]")).at(-1) ||
    document.body;
  if ($("toast").parentElement !== target) target.append($("toast"));
}
function toast(message) {
  placeToast();
  $("toast").textContent = message;
  $("toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("toast").hidden = true), 5000);
}
function errorAt(id, message) {
  const node = $(id);
  node.textContent = message || "";
  node.hidden = !message;
  if (message && node.closest("dialog[open]"))
    node.scrollIntoView({ block: "nearest", behavior: "instant" });
}
function hasUnshared() {
  return Object.keys(state.dirty).length > 0 || state.recovery.length > 0;
}
function renderRecovery() {
  $("recovery-panel").hidden = !state.recovery.length;
  $("recovery-text").value = state.recovery
    .map((item) => LABELS[item.key] + ": " + item.value)
    .join("\n\n");
}
function rememberRecovery(patch, confirmed) {
  // Keep separate local versions until they are copied or explicitly discarded.
  // Another device must never erase this local copy.
  for (const [key, value] of Object.entries(patch)) {
    if (confirmed?.[key] === value) continue;
    if (
      !state.recovery.some((item) => item.key === key && item.value === value)
    )
      state.recovery.push({ key, value });
  }
  if (confirmed)
    state.recovery = state.recovery.filter(
      (item) => confirmed[item.key] !== item.value
    );
  renderRecovery();
}
function currentEditor(id, epoch) {
  return state.editingId === id && state.editorEpoch === epoch;
}
function rejectRequests(message) {
  for (const item of state.requests.values()) {
    clearTimeout(item.timer);
    item.reject(new Error(message));
  }
  state.requests.clear();
}
function screen(name) {
  for (const id of ["loading", "app"])
    $(`${id}-screen`).hidden = id !== name;
}
async function api(path, body, method) {
  const response = await fetch(`/api/${path}`, {
    method: method || (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("სერვერის პასუხი ვერ წავიკითხე. სცადე ხელახლა.");
  }
  if (!response.ok) {
    const error = new Error(data.error || "მოთხოვნა ვერ შესრულდა.");
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}
async function boot() {
  screen("loading");
  $("loading-retry").hidden = true;
  $("loading-message").textContent = "რვეული იხსნება…";
  const params = new URLSearchParams(location.search);
  const notice = params.get("auth");
  if (notice) history.replaceState(null, "", location.pathname);
  try {
    state.config = await api("config");
    document.querySelectorAll("[data-app-name]").forEach((el) => (el.textContent = state.config.appName));
    document.querySelectorAll("[data-google]").forEach((el) => (el.hidden = !state.config.googleReady));
    const session = await api("session");
    state.session = session.authenticated ? session : null;
  } catch (error) {
    $("loading-message").textContent = navigator.onLine ? error.message : "ინტერნეტკავშირი არ არის. რვეულის გასახსნელად დაუკავშირდი ინტერნეტს.";
    $("loading-retry").hidden = false;
    return;
  }
  enterApp();
  if (notice) showAuthNotice(notice);
}
function enterApp() {
  state.firstSnapshot = true;
  screen("app");
  renderAccount();
  renderList();
  setConnected(false);
  startSession();
}
// Connect when there is a notebook and (for shared accounts) a chosen name.
function startSession() {
  if (!state.session) return;
  if (registered() && !state.session.member) {
    openMemberDialog({ required: true });
    return;
  }
  offerMerge();
  connect();
}
function disconnect(message = "კავშირი შეიცვალა.") {
  const ws = state.ws;
  state.connectionAttempt++;
  state.connecting = false;
  state.connected = false;
  state.ws = null;
  clearTimeout(state.retryTimer);
  rejectRequests(message);
  ws?.close();
}
function setConnected(connected) {
  state.connected = connected;
  const node = $("connection-status");
  node.className = "connection" + (connected ? " connected" : "");
  node.textContent = !state.session ? "" : connected ? "დაკავშირებულია" : "კავშირი არ არის";
  $("offline-banner").hidden = connected || !state.session;
  $("add-booking-button").disabled = Boolean(state.session) && !connected;
  $("history-button").hidden = !state.session;
  $("export-button").hidden = !state.session;
  if (state.editingId) {
    const blocked =
      !connected || !state.editorReady || Boolean(state.editorBusy);
    $("editor-fields").disabled = blocked;
    $("save-booking").disabled = blocked;
    $("discard-draft").disabled = blocked;
    $("cancel-booking").disabled = blocked;
    $("editor-close").disabled =
      Boolean(state.editorBusy) || state.resumePending;
    $("editor-resume").disabled =
      !connected || Boolean(state.editorBusy) || state.resumePending;
    $("editor-resume").hidden = state.editorReady;
    $("save-booking").textContent =
      state.editorBusy === "save" ? "ინახება…" : "შენახვა";
    updateEditorStatus();
  }
}
function scheduleReconnect() {
  if (!state.session) return;
  clearTimeout(state.retryTimer);
  // After a few failures, make sure the sign-in is still valid.
  if (state.retry === 2) recheckSession();
  state.retryTimer = setTimeout(
    connect,
    Math.min(15000, 1000 * 2 ** Math.min(state.retry++, 4))
  );
}
async function connect() {
  if (
    !state.session ||
    (registered() && !state.session.member) ||
    state.connecting ||
    (state.ws && state.ws.readyState !== WebSocket.CLOSED)
  )
    return;
  clearTimeout(state.retryTimer);
  const attempt = ++state.connectionAttempt,
    sessionAtStart = state.session;
  state.connecting = true;
  try {
    if (attempt !== state.connectionAttempt || state.session !== sessionAtStart)
      return;
    const ws = new WebSocket(
      (location.protocol === "https:" ? "wss:" : "ws:") +
        "//" +
        location.host +
        "/api/ws"
    );
    state.ws = ws;
    lastPong = Date.now();
    ws.onmessage = (event) => {
      if (state.ws !== ws) return;
      if (event.data === "pong") {
        lastPong = Date.now();
        return;
      }
      try {
        receive(JSON.parse(event.data));
      } catch (error) {
        console.error("Unable to display update", error);
        toast("განახლების ჩვენება ვერ მოხერხდა. გვერდი განაახლე.");
      }
    };
    ws.onopen = () => {
      state.retry = 0;
      lastPong = Date.now();
    };
    ws.onclose = (event) => {
      if (state.ws !== ws) return;
      state.ws = null;
      state.editorReady = false;
      setConnected(false);
      renderMembers();
      rejectRequests("კავშირი გაწყდა. ცვლილება გადაამოწმე.");
      scheduleReconnect();
    };
    ws.onerror = () => {};
  } catch (error) {
    if (attempt !== state.connectionAttempt) return;
    setConnected(false);
    scheduleReconnect();
  } finally {
    if (attempt === state.connectionAttempt) state.connecting = false;
  }
}
function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    if (
      !state.ws ||
      state.ws.readyState !== WebSocket.OPEN ||
      !state.connected
    ) {
      reject(new Error("კავშირი არ არის. დაელოდე ხელახლა დაკავშირებას."));
      return;
    }
    const requestId = crypto.randomUUID(),
      message = JSON.stringify({ type, ...payload, requestId });
    if (new TextEncoder().encode(message).length > 65536) {
      reject(new Error("ტექსტი მეტისმეტად დიდია."));
      return;
    }
    const timer = setTimeout(() => {
      state.requests.delete(requestId);
      reject(new Error("პასუხი დაგვიანდა. მონაცემები გადაამოწმე."));
    }, 15000);
    state.requests.set(requestId, { resolve, reject, timer, type, payload });
    try {
      state.ws.send(message);
    } catch (error) {
      clearTimeout(timer);
      state.requests.delete(requestId);
      reject(error);
    }
  });
}
function receive(msg) {
  if (msg.type === "ack" || msg.type === "error") {
    const pending = state.requests.get(msg.requestId);
    if (pending) {
      clearTimeout(pending.timer);
      state.requests.delete(msg.requestId);
      if (msg.type === "ack") pending.resolve();
      else {
        const error = new Error(msg.message);
        error.code = msg.code;
        pending.reject(error);
      }
    } else if (msg.type === "error") toast(msg.message);
    if (msg.type === "error" && msg.code === "LOCK_LOST") {
      state.editorReady = false;
      setConnected(state.connected);
      $("editor-resume").hidden = false;
    }
    return;
  }
  if (msg.type === "snapshot") {
    state.bookings = new Map(msg.bookings.map((b) => [b.id, b]));
    state.drafts = new Map(msg.drafts.map((d) => [d.id, d]));
    state.presence = msg.presence;
    for (const resolve of state.snapshotWaiters.splice(0)) resolve();
    setConnected(true);
    renderMembers();
    renderList();
    if (state.editingId) {
      state.editorReady = false;
      setConnected(true);
      resumeEditor();
    }
    if (state.firstSnapshot) {
      state.firstSnapshot = false;
      requestAnimationFrame(() => scrollToDate(today()));
    }
    return;
  }
  if (msg.type === "presence") {
    state.presence = msg.users;
    renderMembers();
    return;
  }
  if (msg.type === "lease") {
    const draft = state.drafts.get(msg.id);
    if (draft) draft.leaseUntil = msg.leaseUntil;
    if (!$("editor-dialog").open) renderList();
    return;
  }
  if (msg.type === "draft") {
    state.drafts.set(msg.draft.id, msg.draft);
    if (state.editingId === msg.draft.id) updateEditorStatus();
    renderList();
    return;
  }
  if (msg.type === "editing") {
    const expected = Array.from(state.requests.values()).some(
      (item) =>
        item.type === "edit.new" ||
        (item.type === "edit.begin" && item.payload.id === msg.draft.id)
    );
    if (!expected) {
      send("edit.release").catch(() => {});
      return;
    }
    state.drafts.set(msg.draft.id, msg.draft);
    openEditor(msg.draft);
    renderList();
    return;
  }
  if (msg.type === "saved") {
    state.bookings.set(msg.booking.id, msg.booking);
    state.drafts.delete(msg.booking.id);
    finishRemoteEdit(
      msg.booking.id,
      msg.booking.data,
      "ჯავშანი უკვე შენახულია სხვა მოწყობილობაზე. შენი გაუზიარებელი ტექსტი ზემოთ დარჩა."
    );
    state.openId = msg.booking.id;
    renderList();
    toast(msg.by ? `${msg.by}: ჯავშანი შენახულია` : "ჯავშანი შენახულია");
    return;
  }
  if (msg.type === "discarded" || msg.type === "cancelled") {
    state.drafts.delete(msg.id);
    if (msg.type === "cancelled") state.bookings.delete(msg.id);
    finishRemoteEdit(
      msg.id,
      null,
      msg.type === "cancelled"
        ? "ჯავშანი სხვა მოწყობილობაზე გაუქმდა. შენი გაუზიარებელი ტექსტი ზემოთ დარჩა."
        : "ცვლილებები სხვა მოწყობილობაზე გაუქმდა. შენი გაუზიარებელი ტექსტი ზემოთ დარჩა."
    );
    renderList();
    toast(
      msg.type === "cancelled"
        ? "ჯავშანი გაუქმებულია"
        : "ცვლილებები გაუქმებულია"
    );
    return;
  }
}
function renderMembers() {
  // Only shared (signed-up) notebooks show who is online.
  const online = registered() && state.connected ? state.presence.filter((person) => person.name) : [];
  $("members").innerHTML = online
    .filter((person) => person.id !== state.session.member?.id)
    .map((person) => `<span class="member online" title="ახლა ხაზზეა">${personChip(person.name, "small")}</span>`)
    .join("");
}
function records() {
  const result = [];
  for (const booking of state.bookings.values()) {
    const draft = state.drafts.get(booking.id);
    result.push({
      ...booking,
      data: draft?.data || booking.data,
      committed: booking.data,
      draft
    });
  }
  for (const draft of state.drafts.values())
    if (!state.bookings.has(draft.id))
      result.push({
        id: draft.id,
        data: draft.data,
        draft,
        updatedAt: draft.updatedAt,
        updatedBy: draft.ownerId
      });
  return result;
}
function renderList() {
  $("month-label").textContent =
    MONTHS[Number(state.month.slice(5)) - 1] + " " + state.month.slice(0, 4);
  const [year, month] = state.month.split("-").map(Number),
    count = new Date(Date.UTC(year, month, 0)).getUTCDate(),
    first = `${state.month}-01`,
    last = `${state.month}-${String(count).padStart(2, "0")}`;
  const all = records(),
    occupied = [...state.bookings.values()].map((b) => b.data);
  const groups = new Map();
  for (const record of all) {
    const d = record.data,
      anchor = isDate(d.start_date)
        ? d.start_date
        : record.committed?.start_date;
    if (!anchor) continue;
    const end = isDate(d.end_date) ? d.end_date : anchor;
    if (anchor > last || end < first) continue;
    const key = anchor < first ? first : anchor;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  let content = "";
  for (let i = 1; i <= count; i++) {
    const date = `${state.month}-${String(i).padStart(2, "0")}`,
      starting = groups.get(date) || [];
    for (const record of starting) content += bookingCard(record, date);
    const covering = occupied.some(
      (d) => d.start_date <= date && d.end_date > date
    );
    const sameDay = occupied.some(
      (d) => d.start_date === date && d.end_date === date
    );
    if (!starting.length && !covering && !sameDay) {
      const checkouts = occupied
        .filter((d) => d.end_date === date && d.start_date < date)
        .map((d) => d.end_time)
        .sort();
      content += freeCard(date, checkouts.at(-1));
    }
  }
  $("booking-list").innerHTML =
    content || '<p class="empty">ამ თვეში ჩანაწერები არ არის.</p>';
}
function freeCard(date, after) {
  const id = `free-${date}`,
    open = state.openId === id;
  return `<article class="entry${date === today() ? " today" : ""}${open ? " is-open" : ""}" data-date="${date}"><button class="entry-header" data-action="toggle" data-id="${id}" type="button" aria-expanded="${open}"><span><span class="entry-title">${esc(dateLabel(date, true))}${date === today() ? '<span class="today-tag">დღეს</span>' : ""}</span><span class="status status-free">თავისუფალია${after ? ` ${esc(after)}-დან` : ""}</span></span><span class="entry-chevron" aria-hidden="true">⌄</span></button>${open ? `<div class="entry-body">${after ? `<p class="footnote">წინა სტუმრის გასვლა: ${esc(after)}. ახალი ჯავშნის საათები გადაამოწმე.</p>` : ""}<button type="button" class="button primary" data-action="new" data-date="${date}" ${state.session && !state.connected ? "disabled" : ""}>+ ჯავშნის დამატება</button></div>` : ""}</article>`;
}
function bookingCard(record, date) {
  const { id, data: d, draft } = record,
    open = state.openId === id,
    active = draft && draft.leaseUntil > Date.now();
  const status =
    draft && !record.committed
      ? active
        ? "draft"
        : null
      : active && draft
        ? d.status
        : record.committed?.status || d.status;
  const statusText = status
    ? (status === "draft" ? "ივსება" : STATUS[status] || "ჩანაწერი") +
    (active && draft && record.committed && status !== record.committed.status
      ? " · იცვლება"
      : "")
    : "";
  const writer = active && draft
    ? draft.ownerName && draft.ownerName !== myName()
      ? `${draft.ownerName} წერს…`
      : "ივსება…"
    : "";
  const locked = active && state.editingId !== id;
  const priceOK =
      d.price !== "" &&
      d.deposit !== "" &&
      Number.isFinite(+d.price) &&
      Number.isFinite(+d.deposit),
    balance = priceOK
      ? money(Math.round((+d.price - +d.deposit) * 100) / 100)
      : "—";
  const headerData =
    isDate(d.start_date) && isDate(d.end_date) ? d : record.committed || d;
  const createdBy =
      record.createdBy ||
      (record.draft?.baseVersion === 0
        ? record.draft.ownerName
        : ""),
    changedBy = record.committed ? record.updatedBy : "",
    attribution = `<span class="booking-attribution">${createdBy ? `<span class="last-edited">შექმნა: ${esc(createdBy)}</span>` : ""}${record.updatedAt && record.committed ? `<span class="last-edited">ბოლო ცვლილება: ${changedBy ? `${esc(changedBy)} · ` : ""}${esc(shortTime(record.updatedAt))}</span>` : ""}</span>`;
  return `<article class="entry${date === today() ? " today" : ""}${open ? " is-open" : ""}" data-booking-id="${esc(id)}" data-date="${date}"><button type="button" class="entry-header" data-action="toggle" data-id="${esc(id)}" aria-expanded="${open}"><span><span class="entry-title">${esc(rangeLabel(headerData))}</span>${statusText ? `<span class="status status-${esc(status)}">${esc(statusText)}</span>` : ""}${writer ? `<span class="writer">${esc(writer)}</span>` : ""}</span><span class="entry-chevron" aria-hidden="true">⌄</span></button>${open ? `<div class="entry-body"><div class="stay-line"><span>შესვლა: ${esc(d.start_date)} · ${esc(d.start_time)}</span><span>გასვლა: ${esc(d.end_date)} · ${esc(d.end_time)}</span></div>${d.status !== "blocked" ? `<div class="detail-group"><div class="detail-label">ადამიანების რაოდენობა</div><div class="detail-value">${esc(d.guests || "—")} სტუმარი</div></div><div class="detail-group"><div class="detail-label">ფასი · სრული თანხა</div><div class="detail-value">${esc(money(d.price))}</div><div class="payments"><div><span class="payment-label">ავანსი</span><span class="payment-value">${esc(money(d.deposit))}</span></div><div><span class="payment-label">დარჩენილი</span><span class="payment-value">${esc(balance)}</span></div></div></div>` : ""}<div class="detail-group"><div class="detail-label">დამატებითი ინფორმაცია</div><p class="note-text">${esc(d.notes || "დამატებითი ინფორმაცია არ არის.")}</p>${d.guest_name ? `<p class="guest-line">სტუმარი: ${esc(d.guest_name)}</p>` : ""}${d.phone ? `<p class="guest-line">ტელეფონი: <a href="tel:${esc(d.phone.replace(/[^\d+]/g, ""))}">${esc(d.phone)}</a></p>` : ""}</div>${draft ? '<p class="preview-warning">წერისას გაზიარებული ცვლილებები. საბოლოოდ დასაფიქსირებლად საჭიროა შენახვა.</p>' : ""}<div class="entry-footer">${attribution}<button type="button" class="button small" data-action="edit" data-id="${esc(id)}" ${!state.connected || locked ? "disabled" : ""}>${locked ? "ახლა იწერება" : draft ? "გაგრძელება" : "რედაქტირება"}</button></div></div>` : ""}</article>`;
}
function moveMonth(delta) {
  const d = new Date(`${state.month}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + delta);
  const month = d.toISOString().slice(0, 7);
  if (month < "2000-01" || month > "2099-12") return;
  state.month = month;
  state.openId = null;
  renderList();
  window.scrollTo({ top: 0, behavior: "instant" });
}
function scrollToDate(date) {
  const exact = document.querySelector(`[data-date="${date}"]`);
  if (exact) exact.scrollIntoView({ block: "center", behavior: "instant" });
}
function formData() {
  return Object.fromEntries(
    FIELDS.map((key) => [key, $("editor-form").elements.namedItem(key).value])
  );
}
function openEditor(draft) {
  if (state.editingId && state.editingId !== draft.id && hasUnshared()) {
    state.editorReady = false;
    send("edit.release").catch(() => {});
    setConnected(state.connected);
    errorAt(
      "editor-error",
      "ჯერ შეინახე ან გადაიტანე ამ ეკრანზე დარჩენილი ტექსტი."
    );
    $("editor-resume").hidden = false;
    return;
  }
  const same = state.editingId === draft.id;
  if (same) rememberRecovery(state.dirty, draft.data);
  else state.recovery = [];
  state.editingId = draft.id;
  state.editorEpoch++;
  state.editorReady = true;
  state.editorBusy = null;
  state.dirty = {};
  state.pendingPatch = {};
  state.patchDrain = null;
  clearTimeout(state.patchTimer);
  state.patchTimer = null;
  for (const key of FIELDS)
    $("editor-form").elements.namedItem(key).value = draft.data[key] ?? "";
  renderRecovery();
  $("editor-title").textContent = draft.baseVersion
    ? "ჯავშნის რედაქტირება"
    : "ახალი ჯავშანი";
  $("cancel-booking").hidden = !draft.baseVersion;
  $("editor-resume").hidden = true;
  errorAt("editor-error", "");
  setConnected(state.connected);
  updateBalance();
  if (!$("editor-dialog").open) $("editor-dialog").showModal();
}
function finishRemoteEdit(id, confirmed, message) {
  if (state.editingId !== id || state.editorBusy) return;
  rememberRecovery(state.dirty, confirmed);
  if (state.recovery.length) {
    state.editorEpoch++;
    state.editorReady = false;
    state.pendingPatch = {};
    state.dirty = {};
    state.patchDrain = null;
    clearTimeout(state.patchTimer);
    state.patchTimer = null;
    setConnected(state.connected);
    $("editor-resume").hidden = false;
    errorAt("editor-error", message);
  } else closeEditor(true);
}
function updateEditorStatus() {
  const pending = Object.keys(state.dirty).length > 0,
    node = $("editor-sync");
  node.className =
    "editor-sync" +
    (!state.connected || !state.editorReady || pending || state.editorBusy
      ? " pending"
      : "");
  node.textContent =
    state.editorBusy === "save"
      ? "ჯავშანი ინახება…"
      : state.editorBusy
        ? "ცვლილებები მოწმდება…"
        : !state.connected
          ? "კავშირი გაწყდა — გაუზიარებელი ტექსტი ამ ეკრანზე რჩება."
          : !state.editorReady
            ? "რედაქტირებისთვის ხელახლა დაკავშირებაა საჭირო."
            : pending
              ? "ცვლილებები იგზავნება…"
              : "ცვლილებები სხვებთან გაზიარებულია · ბოლოს დააჭირე „შენახვას“";
}
function updateBalance() {
  const data = formData(),
    blocked = data.status === "blocked";
  for (const name of ["guests", "price", "deposit"]) {
    const field = $("editor-form").elements.namedItem(name);
    field.required = !blocked;
    field.disabled = blocked;
  }
  const valid =
    data.price !== "" &&
    data.deposit !== "" &&
    Number.isFinite(+data.price) &&
    Number.isFinite(+data.deposit);
  $("editor-balance").textContent = blocked
    ? "ჩვენთვის დაკავებულ დღეებზე თანხა არ აღირიცხება."
    : "დარჩენილი: " +
      (valid
        ? money(Math.round((+data.price - +data.deposit) * 100) / 100)
        : "—");
}
function queuePatch(event) {
  const field = event.target.name;
  if (
    !FIELDS.includes(field) ||
    !state.editorReady ||
    state.editorBusy ||
    !state.connected
  )
    return;
  state.dirty[field] = event.target.value;
  state.pendingPatch[field] = event.target.value;
  errorAt("editor-error", "");
  updateEditorStatus();
  updateBalance();
  const id = state.editingId,
    epoch = state.editorEpoch;
  // A fixed short batch also publishes continuous typing without waiting for a pause.
  if (state.patchTimer === null)
    state.patchTimer = setTimeout(() => {
      state.patchTimer = null;
      flushPatch().catch((error) => {
        if (currentEditor(id, epoch)) errorAt("editor-error", error.message);
      });
    }, 120);
}
function flushPatch() {
  clearTimeout(state.patchTimer);
  state.patchTimer = null;
  const id = state.editingId,
    epoch = state.editorEpoch;
  if (state.patchDrain && state.patchDrain.epoch === epoch)
    return state.patchDrain.promise;
  if (!id || !Object.keys(state.pendingPatch).length) return Promise.resolve();
  // One drain owns all in-flight patches. Save/close await this same promise,
  // even when the debounce timer already sent its batch and emptied the queue.
  const drain = { id, epoch, promise: null };
  state.patchDrain = drain;
  drain.promise = (async () => {
    while (currentEditor(id, epoch) && Object.keys(state.pendingPatch).length) {
      if (!state.editorReady)
        throw new Error("რედაქტირების გაგრძელება ჯერ ხელახლა დაადასტურე.");
      const patch = state.pendingPatch;
      state.pendingPatch = {};
      try {
        await send("edit.patch", { id, patch });
      } catch (error) {
        if (currentEditor(id, epoch))
          for (const key of Object.keys(patch))
            if (
              Object.hasOwn(state.dirty, key) &&
              !Object.hasOwn(state.pendingPatch, key)
            )
              state.pendingPatch[key] = state.dirty[key];
        throw error;
      }
      if (!currentEditor(id, epoch)) return;
      for (const [key, value] of Object.entries(patch))
        if (state.dirty[key] === value) delete state.dirty[key];
      state.recovery = state.recovery.filter(
        (item) => patch[item.key] !== item.value
      );
      renderRecovery();
      updateEditorStatus();
    }
  })().finally(() => {
    if (state.patchDrain === drain) state.patchDrain = null;
  });
  return drain.promise;
}
async function resumeEditor() {
  if (!state.editingId || state.resumePending || state.editorBusy) return;
  state.resumePending = true;
  setConnected(state.connected);
  try {
    await send("edit.begin", { id: state.editingId });
  } catch (error) {
    if (state.editingId) {
      errorAt("editor-error", error.message);
      $("editor-resume").hidden = false;
    }
  } finally {
    state.resumePending = false;
    setConnected(state.connected);
  }
}
function closeEditor(done = false) {
  clearTimeout(state.patchTimer);
  state.patchTimer = null;
  if (!done && state.connected && state.editingId)
    send("edit.release").catch(() => {});
  state.editingId = null;
  state.editorEpoch++;
  state.editorReady = false;
  state.editorBusy = null;
  state.resumePending = false;
  state.dirty = {};
  state.pendingPatch = {};
  state.patchDrain = null;
  state.recovery = [];
  $("editor-form").reset();
  renderRecovery();
  if ($("editor-dialog").open) $("editor-dialog").close();
}
async function requestCloseEditor() {
  if (state.editorBusy || state.resumePending) return;
  const id = state.editingId,
    epoch = state.editorEpoch;
  state.editorBusy = "close";
  setConnected(state.connected);
  try {
    if (Object.keys(state.dirty).length) {
      if (state.connected && state.editorReady) await flushPatch();
      else if (
        !(await confirmAction(
          "ზოგი ცვლილება ჯერ არ გაზიარებულა. დახურვისას ეს ტექსტი დაიკარგება. დახურავ?"
        ))
      )
        return;
    }
    if (
      state.recovery.length &&
      !(await confirmAction(
        "ზემოთ შენახული გაუზიარებელი ტექსტის ასლი დაიკარგება. გადაიტანე რაც გჭირდება, ან დაადასტურე დახურვა."
      ))
    )
      return;
    if (currentEditor(id, epoch)) closeEditor();
  } catch (error) {
    if (currentEditor(id, epoch)) errorAt("editor-error", error.message);
  } finally {
    if (currentEditor(id, epoch)) {
      state.editorBusy = null;
      setConnected(state.connected);
    }
  }
}
async function saveEditor() {
  if (state.editorBusy || !state.editingId) return;
  const id = state.editingId,
    epoch = state.editorEpoch;
  state.editorBusy = "save";
  setConnected(state.connected);
  errorAt("editor-error", "");
  try {
    await flushPatch();
    if (!currentEditor(id, epoch) || !state.editorReady)
      throw new Error("რედაქტირება შეიცვალა. ჩანაწერი გადაამოწმე.");
    if (Object.keys(state.dirty).length)
      throw new Error("ზოგი ცვლილება ჯერ არ გაზიარებულა. სცადე ხელახლა.");
    if (
      state.recovery.length &&
      !(await confirmAction(
        "გაუზიარებელი ტექსტის ასლი ზემოთ არის. შენახვის შემდეგ ის წაიშლება. საჭირო ტექსტი უკვე გადაიტანე?"
      ))
    )
      return;
    await send("edit.save", { id });
    if (currentEditor(id, epoch)) closeEditor(true);
  } catch (error) {
    if (currentEditor(id, epoch)) errorAt("editor-error", error.message);
  } finally {
    if (currentEditor(id, epoch)) {
      state.editorBusy = null;
      setConnected(state.connected);
    }
  }
}
async function discardEditor(cancelBooking = false) {
  if (state.editorBusy || !state.editingId) return;
  const id = state.editingId,
    epoch = state.editorEpoch;
  state.editorBusy = cancelBooking ? "cancel" : "discard";
  setConnected(state.connected);
  try {
    const message = cancelBooking
      ? "გაუქმდეს ჯავშანი და გათავისუფლდეს თარიღები? ჩანაწერი ისტორიაში დარჩება. ავანსის დაბრუნება ცალკე უნდა მოაგვარო."
      : "გაუქმდეს გაზიარებული და ამ ეკრანზე დარჩენილი ცვლილებები? ადრე შენახული ჯავშანი დარჩება.";
    if (!(await confirmAction(message))) return;
    clearTimeout(state.patchTimer);
    state.patchTimer = null;
    state.pendingPatch = {};
    // Let a transmitted batch settle before discarding; its failure must not
    // requeue stale text into another editor after the user confirms deletion.
    if (state.patchDrain)
      try {
        await state.patchDrain.promise;
      } catch {}
    if (!currentEditor(id, epoch)) return;
    state.pendingPatch = {};
    await send(cancelBooking ? "booking.cancel" : "edit.discard", { id });
    if (currentEditor(id, epoch)) closeEditor(true);
  } catch (error) {
    if (currentEditor(id, epoch)) errorAt("editor-error", error.message);
  } finally {
    if (currentEditor(id, epoch)) {
      state.editorBusy = null;
      setConnected(state.connected);
    }
  }
}
function confirmAction(message) {
  $("confirm-message").textContent = message;
  $("confirm-dialog").showModal();
  return new Promise((resolve) => (confirmResolve = resolve));
}
function resolveConfirm(value) {
  $("confirm-dialog").close();
  confirmResolve?.(value);
  confirmResolve = null;
}
async function history() {
  if (!$("history-dialog").open) $("history-dialog").showModal();
  $("history-list").textContent = "იტვირთება…";
  try {
    const result = await api("history"),
      latest = new Map();
    for (const item of result.history)
      if (!latest.has(item.booking_id)) latest.set(item.booking_id, item.id);
    const actions = {
      created: "ჯავშანი დაემატა",
      updated: "ჯავშანი შეიცვალა",
      cancelled: "ჯავშანი გაუქმდა",
      restored: "ჯავშანი აღდგა"
    };
    $("history-list").innerHTML =
      result.history
        .map((item) => {
          const changed = FIELDS.filter(
            (key) => (item.before?.[key] ?? "") !== (item.after?.[key] ?? "")
          );
          const fmt = (key, value) =>
            key === "status" ? STATUS[value] || value : value;
          return `<article class="history-item"><h3>${esc(actions[item.action] || item.action)}</h3><p>${esc(rangeLabel(item.after || item.before || {}))}</p><p class="history-meta">${item.actor ? `${esc(item.actor)} · ` : ""}${esc(shortTime(item.at))}</p><details><summary>რა შეიცვალა</summary><div class="history-changes">${changed.map((key) => `<p><strong>${esc(LABELS[key])}</strong><br>${item.before ? `<del>${esc(fmt(key, item.before[key]) || "—")}</del><br>` : ""}<ins>${esc(fmt(key, item.after?.[key]) || "—")}</ins></p>`).join("")}</div></details>${item.action === "cancelled" && latest.get(item.booking_id) === item.id && !state.bookings.has(item.booking_id) ? `<button type="button" class="button small" data-restore="${esc(item.booking_id)}">ჯავშნის აღდგენა</button>` : ""}</article>`;
        })
        .join("") || '<p class="empty">ცვლილებები ჯერ არ არის.</p>';
  } catch (error) {
    $("history-list").textContent = error.message;
  }
}
async function install() {
  if (deferredInstall) {
    const prompt = deferredInstall;
    deferredInstall = null;
    installPromptAttempted = true;
    await prompt.prompt();
    const choice = await prompt.userChoice;
    if (choice.outcome === "accepted") installVisibility();
  } else showInstallGuidance();
}
function showInstallGuidance() {
  if (!$("install-dialog").open) $("install-dialog").showModal();
}
function maybePromptInstall() {
  if (!state.session || installPromptAttempted) return;
  const installed =
    matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  if (installed) return;
  if (deferredInstall) {
    install().catch((error) => {
      console.error("Unable to show install prompt", error);
      showInstallGuidance();
    });
    return;
  }
  const isIOS =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (isIOS && !installGuidanceShown) {
    installGuidanceShown = true;
    showInstallGuidance();
  }
}
function installVisibility() {
  const installed =
    matchMedia("(display-mode: standalone)").matches ||
    navigator.standalone === true;
  document
    .querySelectorAll(".install-action")
    .forEach((button) => (button.hidden = installed));
}

$("loading-retry").addEventListener("click", boot);
document.addEventListener("click", maybePromptInstall);
$("previous-month").addEventListener("click", () => moveMonth(-1));
$("next-month").addEventListener("click", () => moveMonth(1));
$("today-button").addEventListener("click", () => {
  state.month = today().slice(0, 7);
  renderList();
  scrollToDate(today());
});
$("booking-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  try {
    if (button.dataset.action === "toggle") {
      state.openId =
        state.openId === button.dataset.id ? null : button.dataset.id;
      renderList();
    } else if (button.dataset.action === "new")
      await startBooking(button.dataset.date);
    else if (button.dataset.action === "edit")
      await send("edit.begin", { id: button.dataset.id });
  } catch (error) {
    toast(error.message);
  }
});
$("add-booking-button").addEventListener("click", () => {
  const date =
    state.month === today().slice(0, 7) ? today() : `${state.month}-01`;
  startBooking(date).catch((error) => toast(error.message));
});
$("editor-form").addEventListener("input", queuePatch);
$("editor-form").addEventListener("change", (event) => {
  if (event.target.tagName === "SELECT") queuePatch(event);
});
$("editor-form").addEventListener("submit", (event) => {
  event.preventDefault();
  saveEditor();
});
$("discard-draft").addEventListener("click", () => discardEditor());
$("cancel-booking").addEventListener("click", () => discardEditor(true));
$("editor-close").addEventListener("click", requestCloseEditor);
$("editor-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  requestCloseEditor();
});
$("editor-resume").addEventListener("click", resumeEditor);
$("confirm-yes").addEventListener("click", () => resolveConfirm(true));
$("confirm-no").addEventListener("click", () => resolveConfirm(false));
$("confirm-dialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  resolveConfirm(false);
});
$("history-button").addEventListener("click", history);
$("history-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-restore]");
  if (!button) return;
  if (!(await confirmAction("აღდგეს ეს ჯავშანი? თარიღები ხელახლა შემოწმდება.")))
    return;
  try {
    await send("booking.restore", { id: button.dataset.restore });
    history();
  } catch (error) {
    toast(error.message);
  }
});
$("export-button").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/export", { cache: "no-store" });
    if (!response.ok) throw new Error("ასლის ჩამოტვირთვა ვერ მოხერხდა.");
    const url = URL.createObjectURL(await response.blob()),
      a = document.createElement("a");
    a.href = url;
    a.download = `cottage-bookings-${today()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    toast(error.message);
  }
});
document
  .querySelectorAll("[data-close]")
  .forEach((button) =>
    button.addEventListener("click", () => $(button.dataset.close).close())
  );
document
  .querySelectorAll(".install-action")
  .forEach((button) => button.addEventListener("click", install));
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstall = event;
  installVisibility();
});
window.addEventListener("appinstalled", () => {
  deferredInstall = null;
  installPromptAttempted = true;
  installVisibility();
});
window.addEventListener("offline", () => {
  setConnected(false);
  state.ws?.close();
});
window.addEventListener("online", () => {
  if (!$("loading-screen").hidden) boot();
  else if (!state.ws) connect();
});
window.addEventListener("beforeunload", (event) => {
  if (hasUnshared()) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    if (!state.ws) connect();
    else if (Date.now() - lastPong > 40000) state.ws.close();
  }
});
setInterval(() => {
  if (state.ws?.readyState === WebSocket.OPEN) {
    if (Date.now() - lastPong > 45000) {
      state.ws.close();
      return;
    }
    state.ws.send("ping");
  }
}, 15000);
setInterval(() => {
  if (state.editingId && state.editorReady && state.connected)
    send("edit.heartbeat", { id: state.editingId }).catch((error) => {
      errorAt("editor-error", error.message);
      state.editorReady = false;
      setConnected(state.connected);
      $("editor-resume").hidden = false;
    });
}, 20000);
setInterval(() => {
  if (state.connected && !$("editor-dialog").open) renderList();
}, 30000);
if ("serviceWorker" in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller),
    refreshing = false;
  navigator.serviceWorker
    .register("/sw.js")
    .then((reg) => {
      registration = reg;
      if (reg.waiting) $("update-banner").hidden = false;
      reg.addEventListener("updatefound", () => {
        const worker = reg.installing;
        worker?.addEventListener("statechange", () => {
          if (
            worker.state === "installed" &&
            navigator.serviceWorker.controller
          )
            $("update-banner").hidden = false;
        });
      });
    })
    .catch(() => {});
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // clients.claim() on first install must not reload a form with unsaved text.
    if (!hadController) {
      hadController = true;
      return;
    }
    if (refreshing) return;
    if (
      state.editingId ||
      hasUnshared()
    ) {
      updateReloadPending = true;
      $("update-banner").hidden = false;
      return;
    }
    refreshing = true;
    location.reload();
  });
}
$("update-button").addEventListener("click", () => {
  if (state.editingId || hasUnshared()) {
    toast("ჯერ შეინახე ან დახურე მიმდინარე ჩანაწერი.");
    return;
  }
  if (updateReloadPending) {
    location.reload();
    return;
  }
  registration?.waiting?.postMessage("SKIP_WAITING");
});
document.querySelectorAll("dialog").forEach((dialog) =>
  dialog.addEventListener("close", () => {
    if (dialog.contains($("toast"))) placeToast();
  })
);

// ---- Notebook, accounts and names ----
function waitForSnapshot(ms = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("რვეული ვერ გაიხსნა. შეამოწმე ინტერნეტი და სცადე ხელახლა.")), ms);
    state.snapshotWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
// The first booking in this browser creates the browser's own notebook.
async function startBooking(date) {
  if (!state.session) {
    state.session = await api("notebook", {});
    renderAccount();
    const ready = waitForSnapshot();
    connect();
    await ready;
  } else if (registered() && !state.session.member) {
    openMemberDialog({ required: true });
    return;
  }
  await send("edit.new", { date });
}
function resetNotebookView() {
  state.bookings = new Map();
  state.drafts = new Map();
  state.presence = [];
  state.openId = null;
}
function goFresh(message) {
  disconnect("გამოხვედი ექაუნთიდან.");
  if (state.editingId) closeEditor(true);
  state.session = null;
  state.mergeAsked = false;
  resetNotebookView();
  for (const dialog of document.querySelectorAll("dialog[open]")) if (dialog.id !== "auth-dialog") dialog.close();
  renderAccount();
  renderList();
  setConnected(false);
  if (message) toast(message);
}
async function recheckSession() {
  try {
    const session = await api("session");
    if (!session.authenticated) {
      const wasRegistered = registered();
      goFresh();
      if (wasRegistered) openAuth("login", "შესვლის ვადა ამოიწურა. შედი ხელახლა.");
      return;
    }
    state.session = session;
    renderAccount();
    if (registered() && !session.member) {
      disconnect();
      openMemberDialog({ required: true });
    }
  } catch {}
}
const USER_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>';
function renderAccount() {
  const isRegistered = registered();
  const member = isRegistered ? state.session.member : null;
  $("guest-card").hidden = isRegistered;
  $("family-row").hidden = !isRegistered;
  $("member-chip-name").textContent = member?.name || "აირჩიე სახელი";
  $("member-chip").classList.toggle("missing", isRegistered && !member);
  const avatar = $("account-button");
  avatar.hidden = !isRegistered;
  avatar.className = "account-avatar" + (member ? ` ${personTone(member.name)}` : "");
  avatar.innerHTML = member ? `<span aria-hidden="true">${esc([...member.name.trim()][0] || "?")}</span>` : USER_ICON;
  $("app-subtitle").textContent = isRegistered ? state.session.account.email : "შენი ჯავშნების რვეული";
  renderMembers();
}
// After signing in or up: start again with the account's own notebook.
function enterSession(session) {
  disconnect();
  if (state.editingId) closeEditor(true);
  state.session = session;
  state.mergeAsked = false;
  state.firstSnapshot = true;
  resetNotebookView();
  renderAccount();
  renderList();
  setConnected(false);
  startSession();
}

function openMemberDialog({ required = false } = {}) {
  if (!registered()) return;
  state.memberRequired = required || !state.session.member;
  const members = state.session.members || [];
  const currentId = state.session.member?.id;
  $("member-title").textContent = members.length ? "ვინ ხარ?" : "რა გქვია?";
  $("member-copy").textContent = members.length
    ? "აირჩიე შენი სახელი. ის გამოჩნდება ყველა ჯავშანზე, რომელსაც დაამატებ ან შეცვლი."
    : "სახელი გამოჩნდება შენს ჩანაწერებზე. ოჯახის სხვა წევრები შესვლისას თავიანთ სახელს დაამატებენ.";
  $("member-options").innerHTML = members
    .map((member) => `<button type="button" class="member-option${member.id === currentId ? " current" : ""}" data-member="${esc(member.id)}">${personChip(member.name)}${member.id === currentId ? '<span class="member-now">ახლა</span>' : ""}</button>`)
    .join("");
  $("member-options").hidden = !members.length;
  $("member-add-label").textContent = members.length ? "ან დაამატე შენი სახელი" : "შენი სახელი";
  $("member-cancel").hidden = state.memberRequired;
  $("member-form").reset();
  errorAt("member-error", "");
  if (!$("member-dialog").open) $("member-dialog").showModal();
  if (!members.length) $("member-name").focus();
}
function memberChosen(session) {
  state.session = session;
  state.memberRequired = false;
  if ($("member-dialog").open) $("member-dialog").close();
  renderAccount();
  toast(`ახლა წერს: ${session.member.name}`);
  // Reconnect so others see the new name.
  disconnect();
  startSession();
  if ($("account-dialog").open) showAccount();
}
async function selectMember(id, button) {
  button.disabled = true;
  try {
    memberChosen(await api("session/member", { memberId: id }, "PUT"));
  } catch (error) {
    errorAt("member-error", error.message);
    button.disabled = false;
  }
}

function offerMerge() {
  const count = state.session?.guestBookings || 0;
  if (!registered() || !state.session.member || state.mergeAsked || !count) return;
  state.mergeAsked = true;
  $("merge-copy").textContent = `შესვლამდე ამ ბრაუზერში ${count} ჯავშანი ჩაწერე. გადმოვიტანოთ ამ ექაუნთში? თარიღით დამთხვეული ჯავშანი არ გადმოვა. თუ არ გადმოიტან, ის ჯავშნები წაიშლება.`;
  errorAt("merge-error", "");
  $("merge-keep").disabled = false;
  $("merge-drop").disabled = false;
  $("merge-dialog").showModal();
}
async function finishMerge(keep, button) {
  button.disabled = true;
  try {
    const result = await api("account/merge", { keep });
    $("merge-dialog").close();
    toast(keep ? `გადმოვიდა ${result.imported} ჯავშანი${result.skipped ? `, ${result.skipped} თარიღის დამთხვევის გამო არ გადმოვიდა` : ""}` : "ამ ბრაუზერის ჯავშნები წაიშალა");
    const session = await api("session");
    if (session.authenticated) state.session = session;
  } catch (error) {
    errorAt("merge-error", error.message);
    button.disabled = false;
  }
}

function selectAuthTab(mode) {
  const login = mode === "login";
  $("tab-login").setAttribute("aria-selected", String(login));
  $("tab-register").setAttribute("aria-selected", String(!login));
  $("login-form").hidden = !login;
  $("register-form").hidden = login;
  $("auth-title").textContent = login ? "შესვლა" : "ექაუნთის შექმნა";
  $("auth-lead").textContent = login ? "შედი და შენი ჯავშნები ნებისმიერი მოწყობილობიდან გექნება." : "რაც უკვე ჩაწერე, ექაუნთში დარჩება. მერე ოჯახთან ერთადაც იმუშავებ.";
  const from = login ? $("register-email") : $("login-email"),
    to = login ? $("login-email") : $("register-email");
  if (from.value && !to.value) to.value = from.value;
}
function openAuth(mode = "register", message = "") {
  selectAuthTab(mode);
  errorAt("login-error", mode === "login" ? message : "");
  errorAt("register-error", mode === "register" ? message : "");
  if (!$("auth-dialog").open) $("auth-dialog").showModal();
  (mode === "login" ? $("login-email") : $("register-email")).focus();
}
async function submitAuth(form, path, errorId) {
  if (!form.reportValidity()) return;
  const email = form.elements.email.value.trim(),
    password = (form.elements["current-password"] || form.elements["new-password"]).value,
    button = form.querySelector('[type="submit"]');
  if (state.editingId) {
    errorAt(errorId, "ჯერ შეინახე ან დახურე ჯავშნის რედაქტირება.");
    return;
  }
  button.disabled = true;
  errorAt(errorId, "");
  try {
    const key = await window.passwordKey(email, password);
    const session = await api(path, { email, key });
    form.reset();
    $("auth-dialog").close();
    toast(path === "register" ? "ექაუნთი შეიქმნა" : "შეხვედი ექაუნთში");
    enterSession(session);
  } catch (error) {
    errorAt(errorId, error.message);
  } finally {
    button.disabled = false;
  }
}
const AUTH_NOTICES = {
  "google-email-exists": ["login", "ეს ელფოსტა უკვე რეგისტრირებულია პაროლით. შედი პაროლით, მერე ექაუნთში Google-ს დააკავშირებ."],
  "google-failed": ["login", "Google-ით შესვლა ვერ მოხერხდა. სცადე ხელახლა."],
  "google-off": ["login", "Google-ით შესვლა ჯერ არ არის ჩართული. შედი ელფოსტით."],
  "google-cancelled": ["toast", "Google-ით შესვლა გაუქმდა."],
  "google-in-use": ["toast", "ეს Google ექაუნთი უკვე სხვა რვეულზეა მიბმული."],
  "google-linked": ["toast", "Google დაუკავშირდა შენს ექაუნთს. ახლა Google-ითაც შეხვალ."]
};
function showAuthNotice(code) {
  const notice = AUTH_NOTICES[code];
  if (!notice) return;
  if (notice[0] === "login") openAuth("login", notice[1]);
  else toast(notice[1]);
}

function showAccount() {
  const session = state.session;
  if (!registered()) {
    const count = state.bookings.size;
    $("account-content").innerHTML = `<section class="account-section">
        <p>${!session ? "რასაც ჩაწერ, შეინახება და მხოლოდ ამ ბრაუზერიდან გაიხსნება." : `შენი ${count} ჯავშანი ინახება და მხოლოდ ამ ბრაუზერიდან იხსნება.`} თუ ბრაუზერის მონაცემებს წაშლი, ამ რვეულს ვეღარ გახსნი.</p>
        <p>დარეგისტრირდი, რომ ოჯახთან ერთად იმუშაო და ნებისმიერი მოწყობილობიდან შეხვიდე. რაც უკვე ჩაწერე, ადგილზე დარჩება.</p>
        <button class="button primary full" type="button" data-auth="register">რეგისტრაცია</button>
        <button class="button full" type="button" data-auth="login">შესვლა არსებულ ექაუნთში</button>
      </section>`;
  } else {
    const { account, members, member } = session;
    const google = state.config.googleReady
      ? account.hasGoogle
        ? '<p class="status-line">✓ Google დაკავშირებულია</p>'
        : '<a class="button full" href="/auth/google?mode=link">Google-ის დაკავშირება</a>'
      : "";
    $("account-content").innerHTML = `<section class="account-section">
        <h3>ვინ წერს ამ მოწყობილობიდან</h3>
        <div class="current-person">${member ? personChip(member.name) : '<span class="muted">სახელი არჩეული არ არის</span>'}</div>
        <button class="button full" type="button" data-account="member">სხვა სახელის არჩევა</button>
      </section>
      <section class="account-section">
        <h3>ოჯახის სახელები</h3>
        <p class="muted">ყველა, ვინც ამ ექაუნთით შედის, აქედან ირჩევს თავის სახელს. სახელის წაშლისას მისი ძველი ჩანაწერები უცვლელი რჩება.</p>
        <ul class="member-list">${members.map((item) => `<li>${personChip(item.name)}<button class="text-button danger" type="button" data-remove-member="${esc(item.id)}" aria-label="${esc(item.name)} — წაშლა">წაშლა</button></li>`).join("")}</ul>
        <form id="account-member-form" class="inline-form">
          <label for="account-member-name" class="sr-only">ახალი სახელი</label>
          <input id="account-member-name" name="member-name" maxlength="40" autocomplete="off" placeholder="ახალი სახელი" required />
          <button class="button" type="submit">დამატება</button>
        </form>
        <p id="account-member-error" class="error" role="alert" hidden></p>
      </section>
      <section class="account-section">
        <h3>ექაუნთი</h3>
        <p class="account-email">${esc(account.email)}</p>
        ${google}
        <form id="password-form" class="settings-form">
          <input type="text" name="username" autocomplete="username" value="${esc(account.email)}" class="sr-only" tabindex="-1" readonly aria-hidden="true" />
          <label for="account-password">${account.hasPassword ? "პაროლის შეცვლა" : "პაროლის დაყენება"}
            <span class="password-field">
              <input id="account-password" name="new-password" type="password" autocomplete="new-password" minlength="8" maxlength="200" required />
              <button type="button" class="reveal" aria-label="პაროლის ჩვენება" aria-pressed="false">ნახვა</button>
            </span>
          </label>
          <p class="footnote">${account.hasPassword ? "უკვე შესული მოწყობილობები შესული დარჩება." : "პაროლით ოჯახის სხვა წევრებიც შეძლებენ ამ ელფოსტით შესვლას."}</p>
          <p id="password-error" class="error" role="alert" hidden></p>
          <button class="button full" type="submit">პაროლის შენახვა</button>
        </form>
        <button class="button full" type="button" data-account="sign-out-others">სხვა მოწყობილობებიდან გასვლა</button>
        <button class="button full" type="button" data-account="logout">გასვლა</button>
      </section>`;
  }
  if (!$("account-dialog").open) $("account-dialog").showModal();
}
async function removeMember(id) {
  const member = state.session.members.find((item) => item.id === id);
  if (!member || !(await confirmAction(`„${member.name}“ სიიდან წაიშლება. მისი ჩაწერილი ჯავშნები და ისტორია უცვლელი დარჩება. წავშალოთ?`))) return;
  try {
    state.session = await api(`members/${encodeURIComponent(id)}`, undefined, "DELETE");
    renderAccount();
    showAccount();
    toast("სახელი წაიშალა");
    if (!state.session.member) {
      disconnect();
      openMemberDialog({ required: true });
    }
  } catch (error) {
    toast(error.message);
  }
}
async function signOutOthers(button) {
  if (!(await confirmAction("ყველა სხვა ტელეფონი და კომპიუტერი გამოვა ექაუნთიდან და ხელახლა შესვლა დასჭირდება. ეს მოწყობილობა შესული დარჩება. გავაგრძელოთ?"))) return;
  button.disabled = true;
  try {
    const result = await api("account/sign-out-others", {});
    toast(result.signedOut ? `გამოვიდა ${result.signedOut} მოწყობილობა` : "სხვა შესული მოწყობილობა არ იყო");
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
  }
}
async function logout(button) {
  if (state.editingId) {
    toast("ჯერ შეინახე ან დახურე ჯავშნის რედაქტირება.");
    return;
  }
  button.disabled = true;
  try {
    await api("logout", {});
    $("account-dialog").close();
    goFresh("გამოხვედი ექაუნთიდან");
  } catch (error) {
    toast(error.message);
    button.disabled = false;
  }
}

document.addEventListener("click", (event) => {
  const target = event.target.closest("button, a");
  if (!target) return;
  if (target.matches(".reveal")) {
    const input = target.parentElement.querySelector("input"),
      shown = input.type === "text";
    input.type = shown ? "password" : "text";
    target.setAttribute("aria-pressed", String(!shown));
    target.textContent = shown ? "ნახვა" : "დამალვა";
    return;
  }
  if (target.dataset.auth) {
    const host = target.closest("dialog");
    if (host && host.id !== "auth-dialog") host.close();
    openAuth(target.dataset.auth);
    return;
  }
  if (target.dataset.authTab) return selectAuthTab(target.dataset.authTab);
  if (target.dataset.member) return selectMember(target.dataset.member, target);
  if (target.dataset.removeMember) return removeMember(target.dataset.removeMember);
  const action = target.dataset.account;
  if (action === "member") {
    if (state.editingId) return toast("ჯერ შეინახე ან დახურე ჯავშნის რედაქტირება.");
    $("account-dialog").close();
    openMemberDialog();
  }
  if (action === "sign-out-others") signOutOthers(target);
  if (action === "logout") logout(target);
});
document.addEventListener("submit", async (event) => {
  const form = event.target;
  if (form.id === "account-member-form") {
    event.preventDefault();
    const name = form.elements["member-name"].value.trim();
    if (!name) return;
    try {
      state.session = await api("members", { name, select: false });
      showAccount();
      toast(`„${name}“ დაემატა სიაში`);
    } catch (error) {
      errorAt("account-member-error", error.message);
    }
  }
  if (form.id === "password-form") {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    errorAt("password-error", "");
    try {
      const key = await window.passwordKey(state.session.account.email, form.elements["new-password"].value);
      state.session = await api("account/password", { key });
      showAccount();
      toast("პაროლი შენახულია");
    } catch (error) {
      errorAt("password-error", error.message);
      button.disabled = false;
    }
  }
});
$("member-chip").addEventListener("click", () => {
  if (state.editingId) return toast("ჯერ შეინახე ან დახურე ჯავშნის რედაქტირება.");
  openMemberDialog();
});
$("account-button").addEventListener("click", showAccount);
$("member-dialog").addEventListener("cancel", (event) => {
  if (state.memberRequired) event.preventDefault();
});
$("member-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = event.currentTarget.elements["member-name"].value.trim();
  if (!name) return;
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  errorAt("member-error", "");
  try {
    memberChosen(await api("members", { name, select: true }));
  } catch (error) {
    errorAt("member-error", error.message);
  } finally {
    button.disabled = false;
  }
});
$("merge-keep").addEventListener("click", (event) => finishMerge(true, event.currentTarget));
$("merge-drop").addEventListener("click", (event) => finishMerge(false, event.currentTarget));
$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(event.currentTarget, "login", "login-error");
});
$("register-form").addEventListener("submit", (event) => {
  event.preventDefault();
  submitAuth(event.currentTarget, "register", "register-error");
});
$("forgot-button").addEventListener("click", () => {
  $("auth-dialog").close();
  $("forgot-dialog").showModal();
});
installVisibility();
boot();
