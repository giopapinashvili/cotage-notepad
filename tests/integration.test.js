// Runs the actual Wrangler/workerd server with isolated temporary SQLite data.
// Never connects to a Cloudflare account or reads the project's real .dev.vars.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, cp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import WebSocket from "ws";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const origin = "http://127.0.0.1:8791";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Peer {
  constructor(requestOrigin = origin) {
    this.messages = [];
    this.waiters = new Set();
    this.ws = new WebSocket(`${origin.replace("http:", "ws:")}/api/ws`, {
      headers: { Origin: requestOrigin }
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
    if (reply.type === "error")
      throw Object.assign(new Error(reply.message), { code: reply.code });
  }
  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    const done = once(this.ws, "close");
    this.ws.close();
    await done;
  }
}

test(
  "Family notebook: real HTTP, SQLite and two live WebSocket sessions",
  { timeout: 120000 },
  async (t) => {
    const folder = await mkdtemp(join(tmpdir(), "cottage-integration-"));
    await cp(join(root, "src"), join(folder, "src"), { recursive: true });
    await cp(join(root, "public"), join(folder, "public"), { recursive: true });
    await writeFile(
      join(folder, "package.json"),
      '{"private":true,"type":"module"}'
    );
    const config = JSON.parse(
      await readFile(join(root, "wrangler.jsonc"), "utf8")
    );
    config.name = "cottage-integration-only";
    await writeFile(join(folder, "wrangler.jsonc"), JSON.stringify(config));
    let output = "";
    const processGroup = process.platform !== "win32";
    const child = spawn(
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
        "8791",
        "--inspector-port",
        "9291",
        "--show-interactive-dev-session=false"
      ],
      {
        cwd: folder,
        detached: processGroup,
        env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    child.stdout.on("data", (bytes) => (output += bytes));
    child.stderr.on("data", (bytes) => (output += bytes));
    const peers = [];
    async function http(path, { body, requestOrigin = origin } = {}) {
      const response = await fetch(`${origin}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Origin: requestOrigin,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
      const text = await response.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(
          `/api/${path} returned non-JSON (${response.status}): ${text.slice(0, 500)}\n${output.slice(-2000)}`
        );
      }
      return { response, data };
    }
    async function peer(requestOrigin = origin) {
      const result = new Peer(requestOrigin);
      peers.push(result);
      await result.ready();
      return result;
    }
    try {
      const deadline = Date.now() + 60000;
      while (true) {
        if (child.exitCode !== null)
          throw new Error(`Local Wrangler exited: ${output.slice(-3000)}`);
        try {
          const result = await http("meta");
          if (result.response.ok) break;
        } catch {}
        if (Date.now() > deadline)
          throw new Error(
            `Local Wrangler did not start: ${output.slice(-3000)}`
          );
        await delay(200);
      }
      await t.test(
        "Shared notebook APIs open without passwords or setup codes",
        async () => {
          const meta = await http("meta");
          assert.equal(meta.response.status, 200);
          assert.ok(meta.data.users.some((user) => user.id === "family"));
          assert.equal((await http("me")).data.user.name, "ოჯახი");
          assert.equal((await http("history")).response.status, 200);
          assert.equal((await http("export")).response.status, 200);
          assert.equal(
            (await http("setup", { body: { token: "anything" } })).response
              .status,
            404
          );
          assert.equal(
            (await http("login", { body: { pin: "1234" } })).response.status,
            404
          );
        }
      );
      const giorgi = await peer(),
        deda = await peer();
      let id, secondId;
      await t.test(
        "Typing is broadcast before Save; another editor cannot overwrite the active draft",
        async () => {
          await giorgi.request("edit.new", { date: "2027-06-12" });
          id = (await giorgi.next((m) => m.type === "editing")).draft.id;
          await deda.next((m) => m.type === "draft" && m.draft.id === id);
          await giorgi.request("edit.patch", {
            id,
            patch: {
              guests: "8",
              price: "450",
              deposit: "100",
              notes: "სტუმრები საღამოს მოვლენ.",
              guest_name: "<script>not executable</script>"
            }
          });
          const live = await deda.next(
            (m) =>
              m.type === "draft" &&
              m.draft.id === id &&
              m.draft.data.notes === "სტუმრები საღამოს მოვლენ."
          );
          assert.equal(live.draft.baseVersion, 0);
          await assert.rejects(deda.request("edit.begin", { id }), {
            code: "LOCKED"
          });
          await deda.request("sync");
          const snapshot = await deda.next((m) => m.type === "snapshot");
          assert.equal(snapshot.bookings.length, 0);
          assert.equal(snapshot.drafts[0].data.guests, "8");
          await giorgi.request("edit.save", { id });
          assert.equal(
            (await deda.next((m) => m.type === "saved" && m.booking.id === id))
              .booking.data.price,
            "450.00"
          );
        }
      );
      await t.test(
        "Concurrent overlapping reservations are rejected; exact same-day turnover is allowed",
        async () => {
          await deda.request("edit.new", { date: "2027-06-13" });
          secondId = (await deda.next((m) => m.type === "editing")).draft.id;
          await deda.request("edit.patch", {
            id: secondId,
            patch: { guests: "4", price: "200", start_time: "11:00" }
          });
          await assert.rejects(deda.request("edit.save", { id: secondId }), {
            code: "OVERLAP"
          });
          await deda.request("edit.patch", {
            id: secondId,
            patch: { start_time: "12:00" }
          });
          await deda.request("edit.save", { id: secondId });
          await giorgi.next(
            (m) => m.type === "saved" && m.booking.id === secondId
          );
        }
      );
      await t.test(
        "Invalid money stays a draft; separate bookings can be edited concurrently",
        async () => {
          await giorgi.request("edit.begin", { id });
          await deda.request("edit.begin", { id: secondId });
          await giorgi.request("edit.patch", {
            id,
            patch: { deposit: "9999" }
          });
          await assert.rejects(giorgi.request("edit.save", { id }), {
            code: "INVALID"
          });
          await giorgi.request("sync");
          const current = await giorgi.next((m) => m.type === "snapshot");
          assert.equal(
            current.bookings.find((b) => b.id === id).data.deposit,
            "100.00"
          );
          await giorgi.request("edit.discard", { id });
          await deda.request("edit.discard", { id: secondId });
        }
      );
      await t.test(
        "Long Georgian drafts survive closing and can be resumed on a new connection",
        async () => {
          await giorgi.request("edit.begin", { id });
          const notes = "ა".repeat(10000);
          await giorgi.request("edit.patch", { id, patch: { notes } });
          await deda.next(
            (m) =>
              m.type === "draft" &&
              m.draft.id === id &&
              m.draft.data.notes.length === 10000
          );
          await giorgi.request("edit.release");
          const reconnected = await peer();
          await reconnected.request("sync");
          const current = await reconnected.next((m) => m.type === "snapshot");
          assert.equal(
            current.drafts.find((d) => d.id === id).data.notes,
            notes
          );
          await reconnected.request("edit.begin", { id });
          await reconnected.request("edit.save", { id });
          await reconnected.close();
        }
      );
      await t.test(
        "Cancellation, history and restoration retain records and recheck conflicts",
        async () => {
          await deda.request("edit.begin", { id });
          await deda.request("booking.cancel", { id });
          assert.ok(
            (await http("history")).data.history.some(
              (h) => h.booking_id === id && h.action === "cancelled"
            )
          );
          await giorgi.request("edit.new", { date: "2027-06-12" });
          const replacement = (
            await giorgi.next(
              (m) =>
                m.type === "editing" &&
                m.draft.baseVersion === 0 &&
                m.draft.id !== id
            )
          ).draft.id;
          await giorgi.request("edit.patch", {
            id: replacement,
            patch: { guests: "2", price: "300" }
          });
          await giorgi.request("edit.save", { id: replacement });
          await assert.rejects(deda.request("booking.restore", { id }), {
            code: "OVERLAP"
          });
          await giorgi.request("edit.begin", { id: replacement });
          await giorgi.request("booking.cancel", { id: replacement });
          await deda.request("booking.restore", { id });
          const backup = await http("export");
          assert.equal(backup.response.status, 200);
          assert.ok(
            backup.data.bookings.some(
              (b) => b.id === replacement && b.data.status === "cancelled"
            )
          );
          assert.equal(backup.data.format, "cottage-notebook-export-v1");
        }
      );
      await t.test(
        "Foreign-site WebSocket upgrades are refused",
        async () => {
          await new Promise((resolve, reject) => {
            const socket = new WebSocket(
              `${origin.replace("http:", "ws:")}/api/ws`,
              {
                headers: {
                  Origin: "https://foreign.example"
                }
              }
            );
            socket.on("unexpected-response", (_, response) => {
              try {
                assert.equal(response.statusCode, 403);
                response.resume();
                socket.terminate();
                resolve();
              } catch (error) {
                reject(error);
              }
            });
            socket.on("open", () => {
              socket.terminate();
              reject(new Error("Foreign origin accepted"));
            });
            socket.on("error", () => {});
          });
        }
      );
    } finally {
      for (const peer of peers) peer.ws.terminate();
      try {
        if (processGroup) process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      await Promise.race([once(child, "exit"), delay(3000)]);
      await rm(folder, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250
      });
    }
  }
);
