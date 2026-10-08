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
const USER_STORAGE_KEY = "cottage-notebook-user";
const ACCESS_STORAGE_KEY = "cottage-notebook-access-v1";
const ACCESS_CODE = "20031003";
const state = {
  user: null,
  users: [],
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
function memberName(id) {
  if (id === "family") return "ძველი ჩანაწერი";
  return state.users.find((u) => u.id === id)?.name || "ოჯახის წევრი";
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
  for (const id of ["loading", "access", "choose-user", "app"])
    $(`${id}-screen`).hidden = id !== name;
}
async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body === undefined ? "GET" : "POST",
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
  try {
    if (localStorage.getItem(ACCESS_STORAGE_KEY) !== "accepted") {
      screen("access");
      $("access-code").focus();
      return;
    }
  } catch {
    screen("access");
    $("access-error").textContent =
      "ბრაუზერის მეხსიერებაზე წვდომა ვერ მოხერხდა. ჩართე საიტის მონაცემების შენახვა და სცადე თავიდან.";
    $("access-error").hidden = false;
    return;
  }
  screen("loading");
  $("loading-retry").hidden = true;
  $("loading-message").textContent = "რვეული იხსნება…";
  try {
    const meta = await api("meta");
    state.users = meta.users;
    document
      .querySelectorAll("[data-app-name]")
      .forEach((el) => (el.textContent = meta.appName));
    document.title = meta.appName;
    $("account-options").innerHTML = meta.users
      .map(
        (user) =>
          `<button class="button account-choice" type="button" data-user-id="${esc(user.id)}"><span class="member-avatar" aria-hidden="true">${esc(user.name[0])}</span>${esc(user.name)}</button>`
      )
      .join("");
    let rememberedId;
    try {
      rememberedId = localStorage.getItem(USER_STORAGE_KEY);
    } catch {
      $("choose-user-error").textContent =
        "ამ მოწყობილობაზე სახელი ვერ შეინახება; შემდეგ გახსნაზე თავიდან მოგიწევს არჩევა.";
      $("choose-user-error").hidden = false;
    }
    const rememberedUser = meta.users.find((user) => user.id === rememberedId);
    if (rememberedUser) enterApp(rememberedUser);
    else screen("choose-user");
  } catch (error) {
    $("loading-message").textContent = navigator.onLine
      ? error.message
      : "ინტერნეტკავშირი არ არის. საერთო რვეულის გასახსნელად დაუკავშირდი ინტერნეტს.";
    $("loading-retry").hidden = false;
  }
}
function selectAccount(user) {
  state.users = state.users.map((candidate) =>
    candidate.id === user.id ? user : candidate
  );
  try {
    localStorage.setItem(USER_STORAGE_KEY, user.id);
    $("choose-user-error").hidden = true;
  } catch {
    toast("ამ მოწყობილობაზე სახელი ვერ შეინახა; შემდეგ გახსნაზე თავიდან მოგიწევს არჩევა.");
  }
  enterApp(user);
}
async function switchAccount() {
  if (state.editingId) {
    await requestCloseEditor();
    if (state.editingId) return;
  }
  const ws = state.ws;
  state.user = null;
  state.connectionAttempt++;
  state.connecting = false;
  state.connected = false;
  state.ws = null;
  clearTimeout(state.retryTimer);
  rejectRequests("ანგარიში შეიცვალა.");
  ws?.close();
  screen("choose-user");
}
function enterApp(user) {
  state.user = user;
  state.firstSnapshot = true;
  screen("app");
  renderMembers();
  renderList();
  connect();
}
function setConnected(connected) {
  state.connected = connected;
  const node = $("connection-status");
  node.className = "connection" + (connected ? " connected" : "");
  node.textContent = connected ? "დაკავშირებულია" : "კავშირი არ არის";
  $("offline-banner").hidden = connected;
  $("add-booking-button").disabled = !connected;
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
  if (!state.user) return;
  clearTimeout(state.retryTimer);
  state.retryTimer = setTimeout(
    connect,
    Math.min(15000, 1000 * 2 ** Math.min(state.retry++, 4))
  );
}
async function connect() {
  if (
    !state.user ||
    state.connecting ||
    (state.ws && state.ws.readyState !== WebSocket.CLOSED)
  )
    return;
  clearTimeout(state.retryTimer);
  const attempt = ++state.connectionAttempt,
    userId = state.user.id;
  state.connecting = true;
  try {
    if (attempt !== state.connectionAttempt || state.user?.id !== userId)
      return;
    const ws = new WebSocket(
      (location.protocol === "https:" ? "wss:" : "ws:") +
        "//" +
        location.host +
        `/api/ws?user=${encodeURIComponent(userId)}`
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
    state.users = msg.users;
    state.presence = msg.presence;
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
    toast(`${memberName(msg.by)}: ჯავშანი შენახულია`);
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
  const user = state.user;
  $("members").innerHTML = user
    ? `<span class="member${state.connected && state.presence.includes(user.id) ? " online" : ""}" data-member="${esc(user.id)}"><span class="member-avatar" aria-hidden="true">${esc(user.name[0])}</span><span>${esc(user.name)}</span></span>`
    : "";
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
  return `<article class="entry${date === today() ? " today" : ""}${open ? " is-open" : ""}" data-date="${date}"><button class="entry-header" data-action="toggle" data-id="${id}" type="button" aria-expanded="${open}"><span><span class="entry-title">${esc(dateLabel(date, true))}${date === today() ? '<span class="today-tag">დღეს</span>' : ""}</span><span class="status status-free">თავისუფალია${after ? ` ${esc(after)}-დან` : ""}</span></span><span class="entry-chevron" aria-hidden="true">⌄</span></button>${open ? `<div class="entry-body">${after ? `<p class="footnote">წინა სტუმრის გასვლა: ${esc(after)}. ახალი ჯავშნის საათები გადაამოწმე.</p>` : ""}<button type="button" class="button primary" data-action="new" data-date="${date}" ${!state.connected ? "disabled" : ""}>+ ჯავშნის დამატება</button></div>` : ""}</article>`;
}
function bookingCard(record, date) {
  const { id, data: d, draft } = record,
    open = state.openId === id,
    active = draft && draft.leaseUntil > Date.now();
  const status =
    draft && !record.committed
      ? "draft"
      : ["confirmed", "hold", "blocked"].includes(d.status)
        ? d.status
        : record.committed?.status;
  const statusText =
    (status === "draft" ? "ივსება" : STATUS[status] || "ჩანაწერი") +
    (draft && record.committed && status !== record.committed.status
      ? " · იცვლება"
      : "");
  const writer = draft
    ? `${memberName(draft.ownerId)} · ${active ? "წერს…" : "დაუმთავრებელი ჩანაწერი"}`
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
        ? record.draft.ownerId
        : record.updatedBy),
    attribution = `<span class="booking-attribution"><span class="last-edited">შექმნა: ${esc(memberName(createdBy))}</span>${record.updatedAt ? `<span class="last-edited">ბოლო ცვლილება: ${esc(memberName(record.updatedBy))} · ${esc(shortTime(record.updatedAt))}</span>` : ""}</span>`;
  return `<article class="entry${date === today() ? " today" : ""}${open ? " is-open" : ""}" data-booking-id="${esc(id)}" data-date="${date}"><button type="button" class="entry-header" data-action="toggle" data-id="${esc(id)}" aria-expanded="${open}"><span><span class="entry-title">${esc(rangeLabel(headerData))}</span><span class="status status-${esc(status)}">${esc(statusText)}</span>${writer ? `<span class="writer">${esc(writer)}</span>` : ""}</span><span class="entry-chevron" aria-hidden="true">⌄</span></button>${open ? `<div class="entry-body"><div class="stay-line"><span>შესვლა: ${esc(d.start_date)} · ${esc(d.start_time)}</span><span>გასვლა: ${esc(d.end_date)} · ${esc(d.end_time)}</span></div>${d.status !== "blocked" ? `<div class="detail-group"><div class="detail-label">ადამიანების რაოდენობა</div><div class="detail-value">${esc(d.guests || "—")} სტუმარი</div></div><div class="detail-group"><div class="detail-label">ფასი · სრული თანხა</div><div class="detail-value">${esc(money(d.price))}</div><div class="payments"><div><span class="payment-label">ავანსი</span><span class="payment-value">${esc(money(d.deposit))}</span></div><div><span class="payment-label">დარჩენილი</span><span class="payment-value">${esc(balance)}</span></div></div></div>` : ""}<div class="detail-group"><div class="detail-label">დამატებითი ინფორმაცია</div><p class="note-text">${esc(d.notes || "დამატებითი ინფორმაცია არ არის.")}</p>${d.guest_name ? `<p class="guest-line">სტუმარი: ${esc(d.guest_name)}</p>` : ""}${d.phone ? `<p class="guest-line">ტელეფონი: <a href="tel:${esc(d.phone.replace(/[^\d+]/g, ""))}">${esc(d.phone)}</a></p>` : ""}</div>${draft ? '<p class="preview-warning">წერისას გაზიარებული ცვლილებები. საბოლოოდ დასაფიქსირებლად საჭიროა შენახვა.</p>' : ""}<div class="entry-footer">${attribution}<button type="button" class="button small" data-action="edit" data-id="${esc(id)}" ${!state.connected || locked ? "disabled" : ""}>${locked ? "ახლა იწერება" : draft ? "გაგრძელება" : "რედაქტირება"}</button></div></div>` : ""}</article>`;
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
          return `<article class="history-item"><h3>${esc(actions[item.action] || item.action)}</h3><p>${esc(rangeLabel(item.after || item.before || {}))}</p><p class="history-meta">${esc(memberName(item.user_id))} · ${esc(shortTime(item.at))}</p><details><summary>რა შეიცვალა</summary><div class="history-changes">${changed.map((key) => `<p><strong>${esc(LABELS[key])}</strong><br>${item.before ? `<del>${esc(fmt(key, item.before[key]) || "—")}</del><br>` : ""}<ins>${esc(fmt(key, item.after?.[key]) || "—")}</ins></p>`).join("")}</div></details>${item.action === "cancelled" && latest.get(item.booking_id) === item.id && !state.bookings.has(item.booking_id) ? `<button type="button" class="button small" data-restore="${esc(item.booking_id)}">ჯავშნის აღდგენა</button>` : ""}</article>`;
        })
        .join("") || '<p class="empty">ცვლილებები ჯერ არ არის.</p>';
  } catch (error) {
    $("history-list").textContent = error.message;
  }
}
async function install() {
  if (deferredInstall) {
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
  } else $("install-dialog").showModal();
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
$("access-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("access-code");
  if (input.value !== ACCESS_CODE) {
    $("access-error").textContent = "პაროლი არასწორია.";
    $("access-error").hidden = false;
    input.select();
    return;
  }
  try {
    localStorage.setItem(ACCESS_STORAGE_KEY, "accepted");
  } catch {
    $("access-error").textContent =
      "პაროლი სწორია, მაგრამ ამ მოწყობილობაზე დამახსოვრება ვერ მოხერხდა. ჩართე საიტის მონაცემების შენახვა და სცადე თავიდან.";
    $("access-error").hidden = false;
    return;
  }
  input.value = "";
  $("access-error").hidden = true;
  boot();
});
$("account-options").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-user-id]");
  const user = state.users.find((candidate) => candidate.id === button?.dataset.userId);
  if (user) selectAccount(user);
});
$("switch-account").addEventListener("click", () => {
  switchAccount().catch((error) => toast(error.message));
});
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
      await send("edit.new", { date: button.dataset.date });
    else if (button.dataset.action === "edit")
      await send("edit.begin", { id: button.dataset.id });
  } catch (error) {
    toast(error.message);
  }
});
$("add-booking-button").addEventListener("click", () => {
  const date =
    state.month === today().slice(0, 7) ? today() : `${state.month}-01`;
  send("edit.new", { date }).catch((error) => toast(error.message));
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
  installVisibility();
});
window.addEventListener("offline", () => {
  setConnected(false);
  state.ws?.close();
});
window.addEventListener("online", () => {
  if (!state.ws) connect();
  else if (!$("loading-screen").hidden) boot();
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
installVisibility();
boot();
