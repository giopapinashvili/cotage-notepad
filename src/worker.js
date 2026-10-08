import { DurableObject } from "cloudflare:workers";
import {
  MEMBERS,
  AppError,
  checkedPatch,
  newDraft,
  validateBooking,
  validDate
} from "./domain.js";
import {
  randomToken,
  equal,
  digest,
  validPin,
  pinHash,
  checkOrigin,
  readJSON,
  getSessionToken,
  sessionCookie,
  json
} from "./security.js";

const LEASE_MS = 65000;
const SESSION_MS = 30 * 86400000;
const MAX_BOOKINGS = 10000;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`,
  `CREATE TABLE IF NOT EXISTS throttles (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
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
      this.sql.exec("INSERT OR IGNORE INTO schema_version(version) VALUES (1)");
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
  configured() {
    return Boolean(this.one("SELECT id FROM users LIMIT 1"));
  }
  users() {
    return this.all(
      "SELECT id, name, role FROM users ORDER BY CASE id WHEN 'deda' THEN 0 WHEN 'veko' THEN 1 WHEN 'lika' THEN 2 ELSE 3 END"
    );
  }
  sessionById(id) {
    return this.one(
      "SELECT sessions.id AS session_id, users.id, users.name, users.role FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ? AND expires_at > ?",
      id,
      Date.now()
    );
  }
  async session(request) {
    const token = getSessionToken(request);
    if (!/^[A-Za-z0-9_-]{40,100}$/.test(token))
      throw new AppError("შედი ანგარიშში.", "UNAUTHENTICATED", 401);
    const session = this.sessionById(await digest(token));
    if (!session)
      throw new AppError(
        "სესია დასრულდა. ხელახლა შედი.",
        "UNAUTHENTICATED",
        401
      );
    return session;
  }
  throttle(key, maximum, windowMs) {
    const now = Date.now(),
      row = this.one(
        "SELECT count, expires_at FROM throttles WHERE key = ?",
        key
      );
    if (row && row.expires_at > now && row.count >= maximum)
      throw new AppError(
        "ბევრი მცდელობა დაფიქსირდა. ცოტა ხანში სცადე.",
        "RATE_LIMIT",
        429
      );
    this.sql.exec(
      "INSERT INTO throttles(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END, expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END",
      key,
      now + windowMs,
      now,
      now,
      now + windowMs
    );
  }
  cleanExpired() {
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", Date.now());
    this.sql.exec("DELETE FROM throttles WHERE expires_at <= ?", Date.now());
  }
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/api/meta")
        return json({
          configured: this.configured(),
          users: this.users(),
          appName: this.env.APP_NAME || "აგარაკის ჯავშნები"
        });
      if (!["GET", "HEAD"].includes(request.method)) checkOrigin(request);
      if (request.method === "POST" && path === "/api/setup")
        return await this.setup(request);
      if (request.method === "POST" && path === "/api/login")
        return await this.login(request);
      const user = await this.session(request);
      if (request.method === "GET" && path === "/api/me")
        return json({
          user: { id: user.id, name: user.name, role: user.role },
          appName: this.env.APP_NAME || "აგარაკის ჯავშნები"
        });
      if (request.method === "GET" && path === "/api/ws")
        return this.connect(request, user);
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
        if (user.role !== "admin")
          throw new AppError(
            "მხოლოდ გიორგის შეუძლია სრული ასლის ჩამოტვირთვა.",
            "FORBIDDEN",
            403
          );
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
      if (request.method === "POST" && path === "/api/logout") {
        this.sql.exec("DELETE FROM sessions WHERE id = ?", user.session_id);
        this.revokeSockets(user.session_id);
        return json({ ok: true }, 200, {
          "Set-Cookie": sessionCookie(request, "", 0)
        });
      }
      if (request.method === "POST" && path === "/api/password")
        return await this.changePassword(request, user);
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
  async setup(request) {
    if (this.configured())
      throw new AppError(
        "პირველადი გამართვა უკვე დასრულებულია.",
        "ALREADY_SETUP",
        409
      );
    if (
      typeof this.env.SETUP_TOKEN !== "string" ||
      this.env.SETUP_TOKEN.length < 24
    )
      throw new AppError(
        "სერვერზე SETUP_TOKEN ჯერ დასაყენებელია.",
        "SETUP_REQUIRED",
        503
      );
    this.throttle(
      `setup:${request.headers.get("CF-Connecting-IP") || "local"}`,
      5,
      900000
    );
    const body = await readJSON(request);
    if (!equal(body.token, this.env.SETUP_TOKEN))
      throw new AppError("გამართვის კოდი არასწორია.", "FORBIDDEN", 403);
    validPin(body.pin);
    const pin = body.pin;
    const rows = [];
    for (const member of MEMBERS) {
      const salt = randomToken(24);
      rows.push({
        ...member,
        salt,
        hash: await pinHash(pin, salt)
      });
    }
    this.ctx.storage.transactionSync(() => {
      if (this.configured())
        throw new AppError("გამართვა უკვე დასრულებულია.", "ALREADY_SETUP", 409);
      for (const row of rows)
        this.sql.exec(
          "INSERT INTO users(id,name,role,salt,password_hash) VALUES(?,?,?,?,?)",
          row.id,
          row.name,
          row.role,
          row.salt,
          row.hash
        );
    });
    return json({ ok: true }, 201);
  }
  async login(request) {
    this.cleanExpired();
    this.throttle(
      `login:${request.headers.get("CF-Connecting-IP") || "local"}`,
      5,
      900000
    );
    const body = await readJSON(request);
    if (
      typeof body.user !== "string" ||
      typeof body.pin !== "string" ||
      !/^\d{4}$/.test(body.pin)
    )
      throw new AppError("სახელი ან კოდი არასწორია.", "LOGIN_FAILED", 401);
    const row = this.one("SELECT * FROM users WHERE id = ?", body.user);
    const hash = await pinHash(
      body.pin,
      row?.salt || "unknown-user-constant-salt"
    );
    if (!row || !equal(hash, row.password_hash))
      throw new AppError("სახელი ან კოდი არასწორია.", "LOGIN_FAILED", 401);
    const token = randomToken(32),
      sid = await digest(token);
    const fresh = this.one(
      "SELECT password_hash FROM users WHERE id = ?",
      row.id
    );
    if (!fresh || fresh.password_hash !== row.password_hash)
      throw new AppError("კოდი შეიცვალა. ხელახლა შედი.", "LOGIN_FAILED", 401);
    this.sql.exec(
      "INSERT INTO sessions(id,user_id,expires_at) VALUES(?,?,?)",
      sid,
      row.id,
      Date.now() + SESSION_MS
    );
    return json({ user: { id: row.id, name: row.name, role: row.role } }, 200, {
      "Set-Cookie": sessionCookie(request, token)
    });
  }
  async changePassword(request, user) {
    if (user.role !== "admin")
      throw new AppError("საერთო კოდის შეცვლა მხოლოდ გიორგის შეუძლია.", "FORBIDDEN", 403);
    this.throttle(`pin:${user.id}`, 5, 900000);
    const body = await readJSON(request);
    validPin(body.pin);
    validPin(body.currentPin);
    const current = this.one("SELECT * FROM users WHERE id = ?", user.id);
    if (
      !equal(await pinHash(body.currentPin, current.salt), current.password_hash)
    )
      throw new AppError("მიმდინარე კოდი არასწორია.", "LOGIN_FAILED", 401);
    const rows = [];
    for (const member of MEMBERS) {
      const salt = randomToken(24);
      rows.push({
        id: member.id,
        salt,
        hash: await pinHash(body.pin, salt)
      });
    }
    this.ctx.storage.transactionSync(() => {
      if (!this.sessionById(user.session_id))
        throw new AppError("სესია დასრულდა.", "UNAUTHENTICATED", 401);
      if (
        this.one("SELECT password_hash FROM users WHERE id=?", user.id)
          ?.password_hash !== current.password_hash ||
        this.users().length !== MEMBERS.length
      )
        throw new AppError(
          "კოდი პარალელურად შეიცვალა. ხელახლა სცადე.",
          "CONFLICT",
          409
        );
      for (const row of rows)
        this.sql.exec(
          "UPDATE users SET salt=?, password_hash=? WHERE id=?",
          row.salt,
          row.hash,
          row.id
        );
      this.sql.exec("DELETE FROM sessions");
    });
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      this.releaseConnection(a.connectionId);
      ws.close(4001, "Shared PIN changed");
    }
    this.broadcastPresence();
    return json({ ok: true }, 200, {
      "Set-Cookie": sessionCookie(request, "", 0)
    });
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
      createdAt: row.created_at
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
  connect(request, user) {
    checkOrigin(request);
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
      user: { id: user.id, name: user.name, role: user.role },
      sid: user.session_id,
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
      const attachment = ws.deserializeAttachment();
      // Never deliver new private data to an expired or revoked session.
      if (!attachment || !this.sessionById(attachment.sid)) {
        try {
          ws.close(4001, "Session expired");
        } catch {}
        continue;
      }
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
      if (!a || !this.sessionById(a.sid)) {
        ws.close(4001, "Session expired");
        return;
      }
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
    const existing = this.one(
      "SELECT id FROM drafts WHERE base_version=0 AND owner_id=? LIMIT 1",
      a.user.id
    );
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
        "INSERT INTO bookings(id,data,status,starts_at,ends_at,version,updated_at,updated_by,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,status=excluded.status,starts_at=excluded.starts_at,ends_at=excluded.ends_at,version=excluded.version,updated_at=excluded.updated_at,updated_by=excluded.updated_by",
        draft.id,
        packed,
        validated.data.status,
        validated.start,
        validated.end,
        draft.base_version + 1,
        now,
        a.user.id,
        before?.created_at || now
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
  revokeSockets(sid) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.sid === sid) {
        this.releaseConnection(a.connectionId);
        ws.close(4001, "Signed out");
      }
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
