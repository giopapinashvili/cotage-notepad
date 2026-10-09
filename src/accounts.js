import { DurableObject } from "cloudflare:workers";
import { SESSION_MS } from "./auth.js";

// One store for every account, name and sign-in session of the site.
// An account without an email is a browser notebook: it was created when
// someone first saved a booking without signing up. Signing up later adds an
// email (or Google) to the same account, so its notebook stays where it is.
const DAY = 86400000;
const HOUR = 3600000;
const UNREGISTERED_KEEP = 180 * DAY;
const MAX_MEMBERS = 30;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT UNIQUE, password_hash TEXT, google_sub TEXT UNIQUE, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS idx_accounts_unregistered ON accounts(last_active) WHERE email IS NULL`,
  `CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_members_account_name ON members(account_id, name)`,
  `CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, member_id TEXT, merge_from TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id)`,
  `CREATE TABLE IF NOT EXISTS attempts (key_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL, first_attempt INTEGER NOT NULL)`
];

const fail = (error, status = 400, code = undefined) => ({ ok: false, error, status, code });

export class AccountsStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of SCHEMA) this.sql.exec(statement);
    ctx.blockConcurrencyWhile(async () => {
      if (!(await ctx.storage.getAlarm())) await ctx.storage.setAlarm(Date.now() + HOUR);
    });
  }
  one(query, ...args) {
    return this.sql.exec(query, ...args).toArray()[0] || null;
  }
  all(query, ...args) {
    return this.sql.exec(query, ...args).toArray();
  }
  // Runs a write and returns how many rows it changed.
  run(query, ...args) {
    const cursor = this.sql.exec(query, ...args);
    cursor.toArray();
    return cursor.rowsWritten;
  }

  // ---- Rate limits ----
  blocked(keyHash, limit, windowMs) {
    const row = this.one("SELECT attempts, first_attempt FROM attempts WHERE key_hash = ?", keyHash);
    return Boolean(row && Date.now() - row.first_attempt < windowMs && row.attempts >= limit);
  }
  count(keyHash, windowMs) {
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO attempts (key_hash, attempts, first_attempt) VALUES (?1, 1, ?2)
       ON CONFLICT(key_hash) DO UPDATE SET
         attempts = CASE WHEN ?2 - first_attempt >= ?3 THEN 1 ELSE attempts + 1 END,
         first_attempt = CASE WHEN ?2 - first_attempt >= ?3 THEN ?2 ELSE first_attempt END`,
      keyHash,
      now,
      windowMs
    );
  }

  // ---- Sessions ----
  members(accountId) {
    return this.all("SELECT id, name FROM members WHERE account_id = ? ORDER BY created_at, name", accountId);
  }
  rawSession(tokenHash) {
    if (!tokenHash) return null;
    const row = this.one(
      `SELECT s.token_hash, s.account_id, s.member_id, s.merge_from, s.expires_at, a.email, a.last_active,
         a.password_hash IS NOT NULL AS has_password, a.google_sub IS NOT NULL AS has_google, m.name AS member_name
       FROM sessions s JOIN accounts a ON a.id = s.account_id
       LEFT JOIN members m ON m.id = s.member_id AND m.account_id = s.account_id
       WHERE s.token_hash = ?`,
      tokenHash
    );
    return row && row.expires_at > Date.now() ? row : null;
  }
  session(tokenHash) {
    const row = this.rawSession(tokenHash);
    if (!row) return null;
    const now = Date.now();
    let renewed = false;
    if (row.expires_at - now < SESSION_MS - DAY) {
      this.sql.exec("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", now + SESSION_MS, tokenHash);
      renewed = true;
    }
    if (now - row.last_active > DAY) this.sql.exec("UPDATE accounts SET last_active = ? WHERE id = ?", now, row.account_id);
    let mergeFrom = row.merge_from;
    if (mergeFrom && !this.one("SELECT id FROM accounts WHERE id = ? AND email IS NULL", mergeFrom)) {
      this.sql.exec("UPDATE sessions SET merge_from = NULL WHERE token_hash = ?", tokenHash);
      mergeFrom = null;
    }
    return {
      accountId: row.account_id,
      email: row.email,
      guest: !row.email,
      hasPassword: Boolean(row.has_password),
      hasGoogle: Boolean(row.has_google),
      member: row.member_id && row.member_name ? { id: row.member_id, name: row.member_name } : null,
      members: this.members(row.account_id),
      mergeFrom,
      renewed
    };
  }
  createSession(tokenHash, accountId, mergeFrom = null) {
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO sessions (token_hash, account_id, member_id, merge_from, created_at, expires_at) VALUES (?, ?, NULL, ?, ?, ?)",
      tokenHash,
      accountId,
      mergeFrom,
      now,
      now + SESSION_MS
    );
  }
  deleteSession(tokenHash) {
    if (tokenHash) this.sql.exec("DELETE FROM sessions WHERE token_hash = ?", tokenHash);
  }
  signOutOthers(accountId, tokenHash) {
    return this.run("DELETE FROM sessions WHERE account_id = ? AND token_hash != ?", accountId, tokenHash);
  }
  deleteAccount(accountId) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM sessions WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM members WHERE account_id = ?", accountId);
      this.sql.exec("DELETE FROM accounts WHERE id = ?", accountId);
    });
  }

  // ---- Accounts ----
  createBrowserNotebook(ipKeyHash, tokenHash) {
    if (this.blocked(ipKeyHash, 30, HOUR)) return fail("ამ ქსელიდან ბევრი ახალი რვეული შეიქმნა. სცადე ერთ საათში.", 429);
    this.count(ipKeyHash, HOUR);
    const id = crypto.randomUUID(),
      now = Date.now();
    this.sql.exec("INSERT INTO accounts (id, email, password_hash, google_sub, created_at, last_active) VALUES (?, NULL, NULL, NULL, ?, ?)", id, now, now);
    this.createSession(tokenHash, id);
    return { ok: true, accountId: id };
  }
  register({ email, passwordHash, ipKeyHash, currentTokenHash, newTokenHash }) {
    if (this.blocked(ipKeyHash, 10, HOUR)) return fail("ამ ქსელიდან ბევრი ექაუნთი შეიქმნა. სცადე ერთ საათში.", 429);
    this.count(ipKeyHash, HOUR);
    const existing = this.one("SELECT password_hash FROM accounts WHERE email = ?", email);
    if (existing)
      return fail(
        existing.password_hash ? "ეს ელფოსტა უკვე რეგისტრირებულია. შედი შენი პაროლით." : "ეს ელფოსტა უკვე რეგისტრირებულია Google-ით. დააჭირე „Google-ით შესვლას“.",
        409,
        "email-exists"
      );
    const current = this.rawSession(currentTokenHash);
    const now = Date.now();
    let accountId = null;
    this.ctx.storage.transactionSync(() => {
      if (current && !current.email) {
        if (this.run("UPDATE accounts SET email = ?, password_hash = ?, last_active = ? WHERE id = ? AND email IS NULL", email, passwordHash, now, current.account_id)) accountId = current.account_id;
      }
      if (!accountId) {
        accountId = crypto.randomUUID();
        this.sql.exec("INSERT INTO accounts (id, email, password_hash, google_sub, created_at, last_active) VALUES (?, ?, ?, NULL, ?, ?)", accountId, email, passwordHash, now, now);
      }
      this.deleteSession(currentTokenHash);
      this.createSession(newTokenHash, accountId);
    });
    return { ok: true, accountId, kept: accountId === current?.account_id };
  }
  loginStart({ email, pairKeyHash, wideKeyHash, window }) {
    if (this.blocked(pairKeyHash, 10, window) || this.blocked(wideKeyHash, 40, window)) return fail("ბევრი მცდელობაა. სცადე 15 წუთში.", 429);
    const account = this.one("SELECT id, password_hash, google_sub FROM accounts WHERE email = ?", email);
    return { ok: true, account };
  }
  loginFailed({ pairKeyHash, wideKeyHash, window }) {
    this.count(pairKeyHash, window);
    this.count(wideKeyHash, window);
  }
  // Signing in from a browser that already has its own notebook: if that
  // notebook has bookings it is kept aside and offered for merging.
  signIn({ accountId, pairKeyHash = null, currentTokenHash, newTokenHash, guestHasData = false }) {
    if (pairKeyHash) this.sql.exec("DELETE FROM attempts WHERE key_hash = ?", pairKeyHash);
    const current = this.rawSession(currentTokenHash);
    let mergeFrom = null,
      removedGuest = null;
    this.ctx.storage.transactionSync(() => {
      if (current && current.account_id !== accountId && !current.email) {
        if (guestHasData) mergeFrom = current.account_id;
        else removedGuest = current.account_id;
      }
      this.deleteSession(currentTokenHash);
      this.createSession(newTokenHash, accountId, mergeFrom);
    });
    if (removedGuest) this.deleteAccount(removedGuest);
    return { ok: true, mergeFrom, removedGuest };
  }
  googleSignIn({ sub, email, mode, currentTokenHash, newTokenHash, guestHasData }) {
    const current = this.rawSession(currentTokenHash);
    const owner = this.one("SELECT id FROM accounts WHERE google_sub = ?", sub);
    if (mode === "link" && current?.email) {
      if (owner && owner.id !== current.account_id) return fail("in-use", 409, "google-in-use");
      this.sql.exec("UPDATE accounts SET google_sub = ? WHERE id = ?", sub, current.account_id);
      return { ok: true, linked: true };
    }
    if (owner) return this.signIn({ accountId: owner.id, currentTokenHash, newTokenHash, guestHasData });
    if (this.one("SELECT id FROM accounts WHERE email = ?", email)) return fail("exists", 409, "google-email-exists");
    const now = Date.now();
    let accountId = null;
    this.ctx.storage.transactionSync(() => {
      if (current && !current.email) {
        if (this.run("UPDATE accounts SET email = ?, google_sub = ?, last_active = ? WHERE id = ? AND email IS NULL", email, sub, now, current.account_id)) accountId = current.account_id;
      }
      if (!accountId) {
        accountId = crypto.randomUUID();
        this.sql.exec("INSERT INTO accounts (id, email, password_hash, google_sub, created_at, last_active) VALUES (?, ?, NULL, ?, ?, ?)", accountId, email, sub, now, now);
      }
      this.deleteSession(currentTokenHash);
      this.createSession(newTokenHash, accountId);
    });
    return { ok: true, accountId };
  }
  setPassword(accountId, passwordHash) {
    this.sql.exec("UPDATE accounts SET password_hash = ? WHERE id = ? AND email IS NOT NULL", passwordHash, accountId);
  }
  finishMerge(tokenHash, guestId) {
    this.sql.exec("UPDATE sessions SET merge_from = NULL WHERE token_hash = ?", tokenHash);
    if (guestId && this.one("SELECT id FROM accounts WHERE id = ? AND email IS NULL", guestId)) this.deleteAccount(guestId);
  }

  // ---- Names ----
  addMember(accountId, tokenHash, name, select) {
    let member = this.one("SELECT id, name FROM members WHERE account_id = ? AND name = ?", accountId, name);
    if (!member) {
      if (this.one("SELECT count(*) AS n FROM members WHERE account_id = ?", accountId).n >= MAX_MEMBERS)
        return fail(`სახელების სია სავსეა (მაქსიმუმ ${MAX_MEMBERS}). ზედმეტი სახელი წაშალე.`, 409);
      member = { id: crypto.randomUUID(), name };
      this.sql.exec("INSERT INTO members (id, account_id, name, created_at) VALUES (?, ?, ?, ?)", member.id, accountId, name, Date.now());
    }
    if (select) this.sql.exec("UPDATE sessions SET member_id = ? WHERE token_hash = ? AND account_id = ?", member.id, tokenHash, accountId);
    return { ok: true, member };
  }
  selectMember(accountId, tokenHash, memberId) {
    const member = this.one("SELECT id, name FROM members WHERE id = ? AND account_id = ?", memberId, accountId);
    if (!member) return fail("ეს სახელი სიიდან წაშლილია. აირჩიე სხვა ან დაამატე თავიდან.", 404);
    this.sql.exec("UPDATE sessions SET member_id = ? WHERE token_hash = ? AND account_id = ?", member.id, tokenHash, accountId);
    return { ok: true, member };
  }
  removeMember(accountId, memberId) {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("UPDATE sessions SET member_id = NULL WHERE member_id = ? AND account_id = ?", memberId, accountId);
      this.sql.exec("DELETE FROM members WHERE id = ? AND account_id = ?", memberId, accountId);
    });
  }

  // ---- Daily clean-up ----
  async alarm() {
    const now = Date.now();
    this.sql.exec("DELETE FROM sessions WHERE expires_at < ?", now);
    this.sql.exec("DELETE FROM attempts WHERE first_attempt < ?", now - DAY);
    const stale = this.all("SELECT id FROM accounts WHERE email IS NULL AND last_active < ? LIMIT 50", now - UNREGISTERED_KEEP);
    for (const { id } of stale) {
      try {
        await this.env.NOTEBOOK.get(this.env.NOTEBOOK.idFromName("notebook:" + id)).wipe();
      } catch (error) {
        console.error("Could not clear an unused notebook", error?.message);
        continue;
      }
      this.deleteAccount(id);
    }
    await this.ctx.storage.setAlarm(Date.now() + (stale.length === 50 ? HOUR : DAY));
  }
}
