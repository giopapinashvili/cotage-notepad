import { DurableObject } from "cloudflare:workers";
import {
  MEMBERS,
  AppError,
  checkedPatch,
  newDraft,
  validateBooking,
  validDate
} from "./domain.js";
import { checkOrigin, json } from "./security.js";

const LEASE_MS = 65000;
const MAX_BOOKINGS = 10000;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, data TEXT NOT NULL, status TEXT NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_active_interval ON bookings(starts_at, ends_at) WHERE status != 'cancelled'`,
  `CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, data TEXT NOT NULL, base_version INTEGER NOT NULL, revision INTEGER NOT NULL, owner_id TEXT NOT NULL, connection_id TEXT, lease_until INTEGER NOT NULL, updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, action TEXT NOT NULL, user_id TEXT NOT NULL, at INTEGER NOT NULL, before_data TEXT, after_data TEXT)`,
  `CREATE INDEX IF NOT EXISTS idx_history_at ON history(at DESC)`
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (
      url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ) {
      if (request.method !== "GET" || url.pathname.startsWith("/api/"))
        return json(
          { error: "საჭიროა დაცული HTTPS კავშირი.", code: "HTTPS_REQUIRED" },
          400
        );
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    if (url.pathname.startsWith("/api/"))
      return env.NOTEBOOK.get(
        env.NOTEBOOK.idFromName("family-notebook-v1")
      ).fetch(request);
    return env.ASSETS.fetch(request);
  }
};

export class FamilyNotebook extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    // Durable Object schema is private to this one room; idempotent initial migration.
    ctx.storage.transactionSync(() => {
      for (const statement of SCHEMA) this.sql.exec(statement);
      const version =
        this.one("SELECT MAX(version) AS version FROM schema_version")?.version ||
        0;
      if (version < 2) {
        this.sql.exec("DROP TABLE IF EXISTS sessions");
        this.sql.exec("DROP TABLE IF EXISTS throttles");
        this.sql.exec("DROP TABLE IF EXISTS users");
        this.sql.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (2)");
      }
      const bookingColumns = this.all("PRAGMA table_info(bookings)");
      if (!bookingColumns.some((column) => column.name === "created_by")) {
        this.sql.exec(
          "ALTER TABLE bookings ADD COLUMN created_by TEXT NOT NULL DEFAULT 'family'"
        );
      }
      this.sql.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (3)");
    });
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }
  one(query, ...args) {
    return this.sql.exec(query, ...args).toArray()[0] || null;
  }
  all(query, ...args) {
    return this.sql.exec(query, ...args).toArray();
  }
  users() {
    return MEMBERS;
  }
  userById(id) {
    const user = MEMBERS.find((member) => member.id === id);
    if (!user) throw new AppError("აირჩიე ოჯახის წევრი.", "USER_REQUIRED", 400);
    return user;
  }
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/meta")
        return json({
          users: this.users(),
          appName: this.env.APP_NAME || "აგარაკის ჯავშნები"
        });
      if (request.method === "GET" && path === "/api/me")
        return json({
          user: this.userById(new URL(request.url).searchParams.get("user")),
          appName: this.env.APP_NAME || "აგარაკის ჯავშნები"
        });
      if (request.method === "GET" && path === "/api/ws")
        return this.connect(request);
      if (request.method === "GET" && path === "/api/history")
        return json({
          history: this.all(
            "SELECT id, booking_id, action, user_id, at, before_data, after_data FROM history ORDER BY id DESC LIMIT 200"
          ).map((row) => ({
            ...row,
            before: row.before_data ? JSON.parse(row.before_data) : null,
            after: row.after_data ? JSON.parse(row.after_data) : null,
            before_data: undefined,
            after_data: undefined
          }))
        });
      if (request.method === "GET" && path === "/api/export") {
        return json(
          {
            format: "cottage-notebook-export-v1",
            exportedAt: new Date().toISOString(),
            bookings: this.all("SELECT * FROM bookings ORDER BY starts_at").map(
              (row) => this.bookingView(row)
            ),
            drafts: this.drafts(),
            history: this.all("SELECT * FROM history ORDER BY id")
          },
          200,
          {
            "Content-Disposition":
              'attachment; filename="cottage-bookings-backup.json"'
          }
        );
      }
      throw new AppError("მისამართი ვერ მოიძებნა.", "NOT_FOUND", 404);
    } catch (error) {
      return this.errorResponse(error);
    }
  }
  errorResponse(error) {
    if (!(error instanceof AppError))
      console.error("Notebook request failed:", error?.stack || error);
    return json(
      {
        error:
          error instanceof AppError
            ? error.message
            : "სერვერზე შეცდომაა. ჩანაწერი არ წაშლილა; სცადე ხელახლა.",
        code: error.code || "SERVER_ERROR"
      },
      error.status || 500
    );
  }
  bookings() {
    return this.all(
      "SELECT * FROM bookings WHERE status != 'cancelled' ORDER BY starts_at"
    ).map((row) => this.bookingView(row));
  }
  bookingView(row) {
    return {
      id: row.id,
      data: JSON.parse(row.data),
      version: row.version,
      updatedAt: row.updated_at,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      createdBy: row.created_by
    };
  }
  drafts() {
    return this.all("SELECT * FROM drafts ORDER BY updated_at").map((row) =>
      this.draftView(row)
    );
  }
  draftView(row) {
    return {
      id: row.id,
      data: JSON.parse(row.data),
      baseVersion: row.base_version,
      revision: row.revision,
      ownerId: row.owner_id,
      leaseUntil: row.lease_until,
      updatedAt: row.updated_at
    };
  }
  snapshot() {
    return {
      type: "snapshot",
      bookings: this.bookings(),
      drafts: this.drafts(),
      users: this.users(),
      presence: this.presence(),
      serverTime: Date.now()
    };
  }
  connect(request) {
    checkOrigin(request);
    const user = this.userById(new URL(request.url).searchParams.get("user"));
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
      throw new AppError("საჭიროა WebSocket კავშირი.", "UPGRADE_REQUIRED", 426);
    if (this.ctx.getWebSockets().length >= 32)
      throw new AppError(
        "ძალიან ბევრი მოწყობილობაა დაკავშირებული.",
        "TOO_MANY_CONNECTIONS",
        429
      );
    const pair = new WebSocketPair(),
      client = pair[0],
      server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      user,
      connectionId: crypto.randomUUID(),
      window: Date.now(),
      count: 0
    });
    this.send(server, this.snapshot());
    this.broadcastPresence();
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Cache-Control": "no-store" }
    });
  }
  send(ws, data) {
    try {
      ws.send(JSON.stringify(data));
    } catch {
      /* close callback releases editor lease */
    }
  }
  broadcast(data) {
    const packet = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(packet);
      } catch {}
    }
  }
  presence() {
    return [
      ...new Set(
        this.ctx
          .getWebSockets()
          .map((ws) => ws.deserializeAttachment()?.user?.id)
          .filter(Boolean)
      )
    ];
  }
  broadcastPresence() {
    this.broadcast({ type: "presence", users: this.presence() });
  }
  async webSocketMessage(ws, message) {
    let requestId;
    try {
      if (message === "ping") {
        ws.send("pong");
        return;
      }
      if (
        typeof message !== "string" ||
        new TextEncoder().encode(message).length > 65536
      ) {
        this.send(ws, {
          type: "error",
          code: "TOO_LARGE",
          message: "მოთხოვნა მეტისმეტად დიდია. ტექსტი შეამცირე."
        });
        ws.close(1009, "Message too large");
        return;
      }
      const a = ws.deserializeAttachment();
      if (!a) throw new AppError("კავშირის მონაცემები ვერ მოიძებნა.");
      const now = Date.now();
      if (now - a.window > 10000) {
        a.window = now;
        a.count = 0;
      }
      if (++a.count > 150)
        throw new AppError(
          "ცვლილებები ძალიან სწრაფად იგზავნება.",
          "RATE_LIMIT",
          429
        );
      ws.serializeAttachment(a);
      let msg;
      try {
        msg = JSON.parse(message);
      } catch {
        throw new AppError("მოთხოვნა არასწორია.");
      }
      requestId =
        typeof msg.requestId === "string"
          ? msg.requestId.slice(0, 100)
          : undefined;
      switch (msg.type) {
        case "sync":
          this.send(ws, this.snapshot());
          break;
        case "edit.new":
          this.beginNew(ws, a, msg);
          break;
        case "edit.begin":
          this.beginEdit(ws, a, msg);
          break;
        case "edit.patch":
          this.patchDraft(ws, a, msg);
          break;
        case "edit.save":
          this.saveDraft(ws, a, msg);
          break;
        case "edit.discard":
          this.discardDraft(ws, a, msg);
          break;
        case "edit.release":
          this.releaseConnection(a.connectionId);
          break;
        case "edit.heartbeat": {
          const draft = this.ownedDraft(a, msg.id);
          this.sql.exec(
            "UPDATE drafts SET lease_until=? WHERE id=?",
            now + LEASE_MS,
            draft.id
          );
          this.broadcast({
            type: "lease",
            id: draft.id,
            leaseUntil: now + LEASE_MS
          });
          break;
        }
        case "booking.cancel":
          this.cancelBooking(ws, a, msg);
          break;
        case "booking.restore":
          this.restoreBooking(ws, a, msg);
          break;
        default:
          throw new AppError("მოქმედება უცნობია.");
      }
      if (requestId) this.send(ws, { type: "ack", requestId });
    } catch (error) {
      if (!(error instanceof AppError))
        console.error("Notebook realtime failed:", error?.stack || error);
      this.send(ws, {
        type: "error",
        requestId,
        code: error.code || "SERVER_ERROR",
        message:
          error instanceof AppError
            ? error.message
            : "ცვლილება ვერ შეინახა. შენს ტექსტს ეკრანზე ვინახავთ; სცადე ხელახლა."
      });
    }
  }
  validateId(id) {
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id))
      throw new AppError("ჩანაწერი ვერ მოიძებნა.", "NOT_FOUND", 404);
  }
  beginNew(ws, a, msg) {
    if (!validDate(msg.date)) throw new AppError("აირჩიე სწორი თარიღი.");
    this.releaseConnection(a.connectionId);
    const existing = this.all(
      "SELECT id, data FROM drafts WHERE base_version=0 AND owner_id=? ORDER BY updated_at DESC",
      a.user.id
    ).find((draft) => JSON.parse(draft.data).start_date === msg.date);
    if (existing) {
      this.beginEdit(ws, a, { id: existing.id });
      return;
    }
    if (this.one("SELECT count(*) AS n FROM bookings").n >= MAX_BOOKINGS)
      throw new AppError(
        "ჩანაწერების ზღვარი მიღწეულია. საჭიროა არქივის გაფართოება."
      );
    const id = crypto.randomUUID(),
      now = Date.now(),
      data = newDraft(msg.date);
    this.sql.exec(
      "INSERT INTO drafts(id,data,base_version,revision,owner_id,connection_id,lease_until,updated_at) VALUES(?,?,0,1,?,?,?,?)",
      id,
      JSON.stringify(data),
      a.user.id,
      a.connectionId,
      now + LEASE_MS,
      now
    );
    const draft = this.draftView(
      this.one("SELECT * FROM drafts WHERE id=?", id)
    );
    this.broadcast({ type: "draft", draft });
    this.send(ws, { type: "editing", draft });
  }
  beginEdit(ws, a, msg) {
    this.validateId(msg.id);
    const now = Date.now(),
      existing = this.one("SELECT * FROM drafts WHERE id=?", msg.id);
    if (
      existing &&
      existing.connection_id !== a.connectionId &&
      existing.lease_until > now
    )
      throw new AppError(
        `${MEMBERS.find((m) => m.id === existing.owner_id)?.name || "სხვა წევრი"} ამ ჯავშანს ცვლის. მისი ტექსტი პირდაპირ ჩანს.`,
        "LOCKED",
        409
      );
    const booking = this.one(
      "SELECT * FROM bookings WHERE id=? AND status != 'cancelled'",
      msg.id
    );
    if (!existing && !booking)
      throw new AppError("ჯავშანი ვერ მოიძებნა.", "NOT_FOUND", 404);
    this.releaseConnection(a.connectionId, msg.id);
    if (existing)
      this.sql.exec(
        "UPDATE drafts SET owner_id=?, connection_id=?, lease_until=? WHERE id=?",
        a.user.id,
        a.connectionId,
        now + LEASE_MS,
        msg.id
      );
    else
      this.sql.exec(
        "INSERT INTO drafts(id,data,base_version,revision,owner_id,connection_id,lease_until,updated_at) VALUES(?,?,?,1,?,?,?,?)",
        msg.id,
        booking.data,
        booking.version,
        a.user.id,
        a.connectionId,
        now + LEASE_MS,
        now
      );
    const draft = this.draftView(
      this.one("SELECT * FROM drafts WHERE id=?", msg.id)
    );
    this.broadcast({ type: "draft", draft });
    this.send(ws, { type: "editing", draft });
  }
  ownedDraft(a, id) {
    this.validateId(id);
    const row = this.one("SELECT * FROM drafts WHERE id=?", id);
    if (
      !row ||
      row.connection_id !== a.connectionId ||
      row.owner_id !== a.user.id ||
      row.lease_until < Date.now()
    )
      throw new AppError(
        "რედაქტირების უფლება დასრულდა. ხელახლა გახსენი ჩანაწერი.",
        "LOCK_LOST",
        409
      );
    return row;
  }
  patchDraft(ws, a, msg) {
    const row = this.ownedDraft(a, msg.id),
      patch = checkedPatch(msg.patch),
      data = { ...JSON.parse(row.data), ...patch },
      now = Date.now();
    this.sql.exec(
      "UPDATE drafts SET data=?, revision=revision+1, updated_at=?, lease_until=? WHERE id=?",
      JSON.stringify(data),
      now,
      now + LEASE_MS,
      row.id
    );
    this.broadcast({
      type: "draft",
      draft: this.draftView(this.one("SELECT * FROM drafts WHERE id=?", row.id))
    });
  }
  checkOverlap(id, start, end) {
    const conflict = this.one(
      "SELECT data FROM bookings WHERE id != ? AND status != 'cancelled' AND starts_at < ? AND ends_at > ? LIMIT 1",
      id,
      end,
      start
    );
    if (conflict) {
      const d = JSON.parse(conflict.data);
      throw new AppError(
        `ეს მონაკვეთი დაკავებულია: ${d.start_date} ${d.start_time} — ${d.end_date} ${d.end_time}. შეცვალე თარიღი ან საათი.`,
        "OVERLAP",
        409
      );
    }
  }
  saveDraft(ws, a, msg) {
    const draft = this.ownedDraft(a, msg.id),
      validated = validateBooking(JSON.parse(draft.data)),
      now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const before = this.one("SELECT * FROM bookings WHERE id=?", draft.id);
      if (
        (before?.version || 0) !== draft.base_version ||
        before?.status === "cancelled"
      )
        throw new AppError(
          "ჯავშანი უკვე შეიცვალა. განაახლე ჩანაწერი.",
          "CONFLICT",
          409
        );
      this.checkOverlap(draft.id, validated.start, validated.end);
      const packed = JSON.stringify(validated.data);
      this.sql.exec(
        "INSERT INTO bookings(id,data,status,starts_at,ends_at,version,updated_at,updated_by,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,status=excluded.status,starts_at=excluded.starts_at,ends_at=excluded.ends_at,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
        draft.id,
        packed,
        validated.data.status,
        validated.start,
        validated.end,
        draft.base_version + 1,
        now,
        a.user.id,
        before?.created_at || now,
        before?.created_by || a.user.id
      );
      this.sql.exec(
        "INSERT INTO history(booking_id,action,user_id,at,before_data,after_data) VALUES(?,?,?,?,?,?)",
        draft.id,
        before ? "updated" : "created",
        a.user.id,
        now,
        before?.data || null,
        packed
      );
      this.sql.exec("DELETE FROM drafts WHERE id=?", draft.id);
    });
    this.broadcast({
      type: "saved",
      booking: this.bookingView(
        this.one("SELECT * FROM bookings WHERE id=?", draft.id)
      ),
      by: a.user.id
    });
  }
  discardDraft(ws, a, msg) {
    const draft = this.ownedDraft(a, msg.id);
    this.sql.exec("DELETE FROM drafts WHERE id=?", draft.id);
    this.broadcast({ type: "discarded", id: draft.id });
  }
  cancelBooking(ws, a, msg) {
    const draft = this.ownedDraft(a, msg.id),
      now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const before = this.one(
        "SELECT * FROM bookings WHERE id=? AND status != 'cancelled'",
        draft.id
      );
      if (!before || before.version !== draft.base_version)
        throw new AppError("ჯავშანი უკვე შეიცვალა.", "CONFLICT", 409);
      const after = { ...JSON.parse(before.data), status: "cancelled" };
      this.sql.exec(
        "UPDATE bookings SET data=?,status='cancelled',version=version+1,updated_at=?,updated_by=? WHERE id=?",
        JSON.stringify(after),
        now,
        a.user.id,
        draft.id
      );
      this.sql.exec(
        "INSERT INTO history(booking_id,action,user_id,at,before_data,after_data) VALUES(?,?,?,?,?,?)",
        draft.id,
        "cancelled",
        a.user.id,
        now,
        before.data,
        JSON.stringify(after)
      );
      this.sql.exec("DELETE FROM drafts WHERE id=?", draft.id);
    });
    this.broadcast({ type: "cancelled", id: draft.id });
  }
  restoreBooking(ws, a, msg) {
    this.validateId(msg.id);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const before = this.one(
        "SELECT * FROM bookings WHERE id=? AND status='cancelled'",
        msg.id
      );
      if (!before)
        throw new AppError(
          "ჯავშანი უკვე აღდგენილია ან ვერ მოიძებნა.",
          "CONFLICT",
          409
        );
      const old = this.one(
        "SELECT before_data FROM history WHERE booking_id=? AND action='cancelled' ORDER BY id DESC LIMIT 1",
        msg.id
      );
      if (!old) throw new AppError("აღდგენის ჩანაწერი ვერ მოიძებნა.");
      const validated = validateBooking(JSON.parse(old.before_data));
      this.checkOverlap(msg.id, validated.start, validated.end);
      const packed = JSON.stringify(validated.data);
      this.sql.exec(
        "UPDATE bookings SET data=?,status=?,version=version+1,updated_at=?,updated_by=? WHERE id=?",
        packed,
        validated.data.status,
        now,
        a.user.id,
        msg.id
      );
      this.sql.exec(
        "INSERT INTO history(booking_id,action,user_id,at,before_data,after_data) VALUES(?,?,?,?,?,?)",
        msg.id,
        "restored",
        a.user.id,
        now,
        before.data,
        packed
      );
    });
    this.broadcast({
      type: "saved",
      booking: this.bookingView(
        this.one("SELECT * FROM bookings WHERE id=?", msg.id)
      ),
      by: a.user.id
    });
  }
  releaseConnection(connectionId, exceptId = "") {
    const rows = this.all(
      "SELECT id FROM drafts WHERE connection_id=? AND id != ?",
      connectionId,
      exceptId
    );
    for (const row of rows) {
      this.sql.exec(
        "UPDATE drafts SET connection_id=NULL,lease_until=0 WHERE id=?",
        row.id
      );
      this.broadcast({
        type: "draft",
        draft: this.draftView(
          this.one("SELECT * FROM drafts WHERE id=?", row.id)
        )
      });
    }
  }
  webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (a) this.releaseConnection(a.connectionId);
    try {
      ws.close();
    } catch {}
    this.broadcastPresence();
  }
  webSocketError(ws) {
    this.webSocketClose(ws);
  }
}
