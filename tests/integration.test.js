// Runs the real Wrangler/workerd server with isolated temporary storage.
// Never connects to a Cloudflare account or reads the project's .dev.vars.
// COTTAGE_URL=http://127.0.0.1:8788 runs the same checks against a server that
// is already running instead (for example `wrangler pages dev` in front of it).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, webcrypto } from "node:crypto";
import { mkdtemp, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 8799;
const external = process.env.COTTAGE_URL?.replace(/\/+$/, "");
const origin = external || `http://127.0.0.1:${port}`;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Same stretching as public/password.js does in the browser.
async function passwordKey(email, password) {
  const encoder = new TextEncoder();
  const material = await webcrypto.subtle.importKey("raw", encoder.encode(password.normalize("NFC")), "PBKDF2", false, ["deriveBits"]);
  const bits = await webcrypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: encoder.encode("cottage-notebook-v1:" + email.trim().toLowerCase()), iterations: 150000 },
    material,
    256
  );
  return Buffer.from(bits).toString("base64url");
}

// One browser: keeps its own session cookie.
function browser() {
  const jar = { cookie: "" };
  async function http(path, { body, method, requestOrigin = origin } = {}) {
    const response = await fetch(`${origin}/api/${path}`, {
      method: method || (body === undefined ? "GET" : "POST"),
      headers: {
        Origin: requestOrigin,
        ...(jar.cookie ? { Cookie: jar.cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" })
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const match = setCookie.match(/session=([^;]*)/);
      if (match) jar.cookie = match[1] ? `session=${match[1]}` : "";
    }
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`/api/${path} returned non-JSON (${response.status}): ${text.slice(0, 300)}`);
    }
    return { response, data };
  }
  return { jar, http };
}

class Peer {
  constructor(jar, requestOrigin = origin) {
    this.messages = [];
    this.waiters = new Set();
    this.ws = new WebSocket(`${origin.replace("http:", "ws:")}/api/ws`, {
      headers: { Origin: requestOrigin, ...(jar?.cookie ? { Cookie: jar.cookie } : {}) }
    });
    this.ws.on("message", (bytes) => {
      if (String(bytes) === "pong") return;
      const message = JSON.parse(String(bytes));
      for (const waiter of this.waiters)
        if (waiter.predicate(message)) {
          this.waiters.delete(waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
          return;
        }
      this.messages.push(message);
    });
    this.ws.on("error", () => {});
  }
  async ready() {
    if (this.ws.readyState !== WebSocket.OPEN) await once(this.ws, "open");
    return this.next((m) => m.type === "snapshot");
  }
  next(predicate) {
    const index = this.messages.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("WebSocket response timeout"));
      }, 8000);
      this.waiters.add(waiter);
    });
  }
  async request(type, payload = {}) {
    const requestId = randomUUID(),
      answer = this.next((m) => m.requestId === requestId);
    this.ws.send(JSON.stringify({ type, ...payload, requestId }));
    const reply = await answer;
    if (reply.type === "error") throw Object.assign(new Error(reply.message), { code: reply.code });
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const done = once(this.ws, "close");
    this.ws.close();
    await done;
  }
}

function refused(jar, requestOrigin = origin) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace("http:", "ws:")}/api/ws`, {
      headers: { Origin: requestOrigin, ...(jar?.cookie ? { Cookie: jar.cookie } : {}) }
    });
    socket.on("unexpected-response", (_, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode);
    });
    socket.on("open", () => {
      socket.terminate();
      reject(new Error("Connection was accepted"));
    });
    socket.on("error", () => {});
  });
}

async function newBooking(peer, date, patch) {
  await peer.request("edit.new", { date });
  const draft = (await peer.next((m) => m.type === "editing")).draft;
  if (patch) await peer.request("edit.patch", { id: draft.id, patch });
  return draft.id;
}

test("Cottage notebooks: browser notebooks, accounts, names and live editing", { timeout: 180000 }, async (t) => {
  let output = "",
    folder = null,
    child = null;
  const processGroup = process.platform !== "win32";
  if (!external) {
    folder = await mkdtemp(join(tmpdir(), "cottage-integration-"));
    await cp(join(root, "src"), join(folder, "src"), { recursive: true });
    await cp(join(root, "public"), join(folder, "public"), { recursive: true });
    await writeFile(join(folder, "package.json"), '{"private":true,"type":"module"}');
    const config = JSON.parse((await readFile(join(root, "wrangler.jsonc"), "utf8")).replace(/^\s*\/\/.*$/gm, ""));
    config.name = "cottage-integration-only";
    await writeFile(join(folder, "wrangler.jsonc"), JSON.stringify(config));
    child = spawn(
      process.execPath,
      [
        join(root, "node_modules/wrangler/bin/wrangler.js"),
        "dev",
        "--config",
        join(folder, "wrangler.jsonc"),
        "--local",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--inspector-port",
        "9299",
        "--show-interactive-dev-session=false"
      ],
      { cwd: folder, detached: processGroup, env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, stdio: ["ignore", "pipe", "pipe"] }
    );
    child.stdout.on("data", (bytes) => (output += bytes));
    child.stderr.on("data", (bytes) => (output += bytes));
  }
  const peers = [];
  const connect = async (jar) => {
    const peer = new Peer(jar);
    peers.push(peer);
    await peer.ready();
    return peer;
  };
  try {
    const probe = browser();
    const deadline = Date.now() + 60000;
    while (true) {
      if (child && child.exitCode !== null) throw new Error(`Local Wrangler exited: ${output.slice(-3000)}`);
      try {
        if ((await probe.http("config")).response.ok) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`Local Wrangler did not start: ${output.slice(-3000)}`);
      await delay(200);
    }

    const email = `family-${Date.now()}@example.com`;
    const key = await passwordKey(email, "agaraki 2027!");
    const phone = browser();
    let gio, id, secondId;

    await t.test("A new browser starts empty; its first booking creates its own notebook", async () => {
      assert.deepEqual((await phone.http("session")).data, { authenticated: false });
      assert.equal(await refused(phone.jar), 401);
      const created = await phone.http("notebook", { body: {} });
      assert.equal(created.response.status, 201);
      assert.equal(created.data.account.guest, true);
      const owner = await connect(phone.jar);
      const draftId = await newBooking(owner, "2027-05-01", { guests: "2", price: "150" });
      await owner.request("edit.save", { id: draftId });
      const saved = await owner.next((m) => m.type === "saved");
      assert.equal(saved.booking.createdBy, "");
      await owner.close();
      // Another browser sees nothing of it.
      const stranger = browser();
      await stranger.http("notebook", { body: {} });
      const other = await connect(stranger.jar);
      assert.equal((await other.request("sync").then(() => other.next((m) => m.type === "snapshot"))).bookings.length, 0);
      await other.close();
    });

    await t.test("Signing up keeps the notebook; registered accounts ask each device for a name", async () => {
      const signedUp = await phone.http("register", { body: { email, key } });
      assert.equal(signedUp.response.status, 201);
      assert.equal(signedUp.data.account.guest, false);
      assert.equal(await refused(phone.jar), 409, "a name is needed first");
      const named = await phone.http("members", { body: { name: "გიო", select: true } });
      assert.equal(named.data.member.name, "გიო");
      gio = await connect(phone.jar);
      gio.messages.length = 0;
      await gio.request("sync");
      const snapshot = await gio.next((m) => m.type === "snapshot");
      assert.equal(snapshot.bookings.length, 1, "the booking from before sign-up is still there");
      assert.deepEqual(snapshot.presence.map((p) => p.name), ["გიო"]);
    });

    const laptop = browser();
    let shorena;
    await t.test("Typing is shared live; another person cannot overwrite an active draft", async () => {
      assert.equal((await laptop.http("login", { body: { email, key: await passwordKey(email, "wrong") } })).response.status, 401);
      const signedIn = await laptop.http("login", { body: { email, key } });
      assert.equal(signedIn.response.status, 200);
      assert.equal(signedIn.data.member, null);
      await laptop.http("members", { body: { name: "შორენა", select: true } });
      shorena = await connect(laptop.jar);
      await gio.next((m) => m.type === "presence" && m.users.length === 2);

      id = await newBooking(gio, "2027-06-15");
      await shorena.next((m) => m.type === "draft" && m.draft.id === id && m.draft.ownerName === "გიო");
      await gio.request("edit.patch", { id, patch: { guests: "8", price: "450", deposit: "100", notes: "სტუმრები საღამოს მოვლენ.", guest_name: "<script>x</script>" } });
      await shorena.next((m) => m.type === "draft" && m.draft.id === id && m.draft.data.notes === "სტუმრები საღამოს მოვლენ.");
      await assert.rejects(shorena.request("edit.begin", { id }), (error) => error.code === "LOCKED" && error.message.includes("გიო"));
      await gio.request("edit.save", { id });
      const saved = await shorena.next((m) => m.type === "saved" && m.booking.id === id);
      assert.equal(saved.booking.data.price, "450.00");
      assert.equal(saved.booking.createdBy, "გიო");
      assert.equal(saved.by, "გიო");
      await gio.next((m) => m.type === "saved" && m.booking.id === id);
      await shorena.request("edit.begin", { id });
      await shorena.next((m) => m.type === "editing" && m.draft.id === id);
      await shorena.request("edit.patch", { id, patch: { notes: "შორენამ განაახლა." } });
      await shorena.request("edit.save", { id });
      const updated = await gio.next((m) => m.type === "saved" && m.booking.id === id);
      assert.equal(updated.booking.createdBy, "გიო");
      assert.equal(updated.booking.updatedBy, "შორენა");
      const history = (await phone.http("history")).data.history.filter((item) => item.booking_id === id);
      assert.ok(history.some((item) => item.action === "created" && item.actor === "გიო"));
      assert.ok(history.some((item) => item.action === "updated" && item.actor === "შორენა"));
    });

    await t.test("Overlaps are refused; same-day turnover is allowed", async () => {
      secondId = await newBooking(shorena, "2027-06-16", { guests: "4", price: "200", start_time: "11:00" });
      await assert.rejects(shorena.request("edit.save", { id: secondId }), { code: "OVERLAP" });
      await shorena.request("edit.patch", { id: secondId, patch: { start_time: "12:00" } });
      await shorena.request("edit.save", { id: secondId });
      await gio.next((m) => m.type === "saved" && m.booking.id === secondId);
    });

    await t.test("Cancel, history and restore keep records and recheck dates", async () => {
      await shorena.request("edit.begin", { id });
      await shorena.request("booking.cancel", { id });
      assert.ok((await phone.http("history")).data.history.some((h) => h.booking_id === id && h.action === "cancelled" && h.actor === "შორენა"));
      const replacement = await newBooking(gio, "2027-06-15", { guests: "2", price: "300" });
      await gio.request("edit.save", { id: replacement });
      await assert.rejects(shorena.request("booking.restore", { id }), { code: "OVERLAP" });
      await gio.request("edit.begin", { id: replacement });
      await gio.request("booking.cancel", { id: replacement });
      await shorena.request("booking.restore", { id });
      const backup = await laptop.http("export");
      assert.equal(backup.response.status, 200);
      assert.equal(backup.data.format, "cottage-notebook-export-v2");
      const original = backup.data.bookings.find((b) => b.id === id);
      assert.equal(original.createdBy, "გიო");
      assert.equal(original.updatedBy, "შორენა");
    });

    await t.test("A browser notebook can be merged into the account after signing in", async () => {
      const tablet = browser();
      await tablet.http("notebook", { body: {} });
      const guest = await connect(tablet.jar);
      const keepId = await newBooking(guest, "2027-08-01", { guests: "3", price: "210" });
      await guest.request("edit.save", { id: keepId });
      const clashId = await newBooking(guest, "2027-06-15", { guests: "3", price: "210" });
      await guest.request("edit.save", { id: clashId });
      await guest.close();
      const signedIn = await tablet.http("login", { body: { email, key } });
      assert.equal(signedIn.data.guestBookings, 2);
      await tablet.http("members", { body: { name: "ლიკა", select: true } });
      const merged = await tablet.http("account/merge", { body: { keep: true } });
      assert.deepEqual(merged.data, { imported: 1, skipped: 1 }, "the clashing booking is not imported");
      assert.equal((await tablet.http("session")).data.guestBookings, 0);
      const added = await gio.next((m) => m.type === "snapshot" && m.bookings.some((b) => b.id === keepId));
      assert.equal(added.bookings.find((b) => b.id === keepId).createdBy, "ლიკა");
    });

    await t.test("Names, passwords and signing out other devices", async () => {
      const removed = await laptop.http(`members/${(await laptop.http("session")).data.member.id}`, { method: "DELETE" });
      assert.equal(removed.data.member, null);
      assert.equal(await refused(laptop.jar), 409);
      const newKey = await passwordKey(email, "new secret 2028");
      assert.equal((await phone.http("account/password", { body: { key: newKey } })).response.status, 200);
      const out = await phone.http("account/sign-out-others", { body: {} });
      assert.ok(out.data.signedOut >= 2);
      assert.equal((await laptop.http("session")).data.authenticated, false);
      assert.equal((await browser().http("login", { body: { email, key: newKey } })).response.status, 200);
    });

    await t.test("Foreign-site requests are refused", async () => {
      assert.equal(await refused(phone.jar, "https://foreign.example"), 403);
      assert.equal((await phone.http("members", { body: { name: "x" }, requestOrigin: "https://foreign.example" })).response.status, 403);
    });
  } finally {
    for (const peer of peers) peer.ws.terminate();
    if (child) {
      try {
        if (processGroup) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      await Promise.race([once(child, "exit"), delay(3000)]);
    }
    if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  }
});
