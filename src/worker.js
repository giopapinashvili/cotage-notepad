import {
  UserError,
  clearOauthCookie,
  clearSessionCookie,
  finishGoogle,
  googleReady,
  hashPasswordKey,
  json,
  normalizeEmail,
  normalizeMemberName,
  publicRedirect,
  randomToken,
  readJson,
  readSessionToken,
  redirect,
  sameOrigin,
  sessionCookie,
  sha256Hex,
  startGoogle,
  validPasswordKey,
  verifyPasswordKey
} from "./auth.js";

export { FamilyNotebook } from "./notebook.js";
export { AccountsStore } from "./accounts.js";

const LOGIN_WINDOW = 15 * 60000;
const appName = (env) => env.APP_NAME || "აგარაკის ჯავშნები";
const error = (message, status = 400, code = undefined) => json(code ? { error: message, code } : { error: message }, status);
const accounts = (env) => env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts-v1"));
const notebook = (env, accountId) => env.NOTEBOOK.get(env.NOTEBOOK.idFromName("notebook:" + accountId));
const clientIp = (request) => request.headers.get("CF-Connecting-IP") || "local";
const keyHash = (key) => sha256Hex("attempt:" + key);
const isUUID = (value) => typeof value === "string" && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value);

function withCookies(response, ...cookies) {
  for (const cookie of cookies) if (cookie) response.headers.append("Set-Cookie", cookie);
  return response;
}

function passwordKeyFrom(input) {
  if (!validPasswordKey(input.key)) throw new UserError("პაროლი ვერ დამუშავდა. განაახლე გვერდი და სცადე ხელახლა.");
  return input.key;
}

async function newToken() {
  const token = randomToken(32);
  return { token, tokenHash: await sha256Hex(token) };
}

async function currentSession(env, request) {
  const token = readSessionToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const session = await accounts(env).session(tokenHash);
  return session ? { ...session, token, tokenHash } : null;
}

async function payload(env, session) {
  let guestBookings = 0;
  if (session.mergeFrom) {
    try {
      guestBookings = await notebook(env, session.mergeFrom).countBookings();
    } catch {}
  }
  return {
    authenticated: true,
    account: { email: session.email, guest: session.guest, hasPassword: session.hasPassword, hasGoogle: session.hasGoogle },
    members: session.members,
    member: session.member,
    guestBookings
  };
}

async function freshPayload(env, tokenHash, token) {
  const session = await accounts(env).session(tokenHash);
  return payload(env, { ...session, token, tokenHash });
}

// Who is writing: registered accounts are shared, so each device picks a name.
// A browser notebook belongs to one browser and needs no name.
function actorOf(session) {
  if (session.guest) return { id: "owner", name: "" };
  if (!session.member) throw new UserError("ჯერ აირჩიე, ვინ ხარ.", 409, "member-required");
  return { id: session.member.id, name: session.member.name };
}

async function guestHasData(env, session) {
  if (!session?.guest) return false;
  try {
    return (await notebook(env, session.accountId).countBookings()) > 0;
  } catch {
    return false;
  }
}

async function wipeNotebook(env, accountId) {
  if (!accountId) return;
  try {
    await notebook(env, accountId).wipe();
  } catch (err) {
    console.error("Could not clear notebook", err?.message);
  }
}

async function forwardToNotebook(request, env, session, needsActor = true) {
  const actor = needsActor ? actorOf(session) : { id: "", name: "" };
  const headers = new Headers(request.headers);
  headers.set("X-Actor-Id", actor.id);
  headers.set("X-Actor-Name", encodeURIComponent(actor.name));
  return notebook(env, session.accountId).fetch(new Request(request, { headers }));
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (!sameOrigin(request)) return error("მოთხოვნის წყარო დაუშვებელია.", 403, "ORIGIN");
  const store = accounts(env);

  if (path === "/api/config" && method === "GET") return json({ googleReady: googleReady(env), appName: appName(env) });

  if (path === "/api/register" && method === "POST") {
    const input = await readJson(request);
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPasswordKey(passwordKeyFrom(input));
    const next = await newToken();
    const current = readSessionToken(request);
    const result = await store.register({
      email,
      passwordHash,
      ipKeyHash: await keyHash("register:" + clientIp(request)),
      currentTokenHash: current ? await sha256Hex(current) : null,
      newTokenHash: next.tokenHash
    });
    if (!result.ok) return error(result.error, result.status, result.code);
    return withCookies(json(await freshPayload(env, next.tokenHash, next.token), 201), sessionCookie(request, next.token));
  }

  if (path === "/api/login" && method === "POST") {
    const input = await readJson(request);
    const email = normalizeEmail(input.email);
    const key = passwordKeyFrom(input);
    const ip = clientIp(request);
    const keys = { pairKeyHash: await keyHash(`login:${ip}:${email}`), wideKeyHash: await keyHash(`login-ip:${ip}`), window: LOGIN_WINDOW };
    const start = await store.loginStart({ email, ...keys });
    if (!start.ok) return error(start.error, start.status, start.code);
    if (!start.account?.password_hash || !(await verifyPasswordKey(key, start.account.password_hash))) {
      await store.loginFailed(keys);
      if (start.account && !start.account.password_hash) return error("ამ ელფოსტით Google-ით ხარ რეგისტრირებული. დააჭირე „Google-ით შესვლას“.", 401, "google-only");
      return error("ელფოსტა ან პაროლი არასწორია.", 401, "wrong-password");
    }
    const current = await currentSession(env, request);
    const next = await newToken();
    const result = await store.signIn({
      accountId: start.account.id,
      pairKeyHash: keys.pairKeyHash,
      currentTokenHash: current?.tokenHash || null,
      newTokenHash: next.tokenHash,
      guestHasData: await guestHasData(env, current)
    });
    await wipeNotebook(env, result.removedGuest);
    return withCookies(json(await freshPayload(env, next.tokenHash, next.token)), sessionCookie(request, next.token));
  }

  if (path === "/api/logout" && method === "POST") {
    const token = readSessionToken(request);
    if (token) await store.deleteSession(await sha256Hex(token));
    return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie(request) });
  }

  const session = await currentSession(env, request);

  if (path === "/api/session" && method === "GET") {
    if (!session) return json({ authenticated: false }, 200, readSessionToken(request) ? { "Set-Cookie": clearSessionCookie(request) } : {});
    return json(await payload(env, session), 200, session.renewed ? { "Set-Cookie": sessionCookie(request, session.token) } : {});
  }

  // The first booking in a browser creates that browser's own notebook.
  if (path === "/api/notebook" && method === "POST") {
    if (session) return json(await payload(env, session));
    const next = await newToken();
    const result = await store.createBrowserNotebook(await keyHash("notebook:" + clientIp(request)), next.tokenHash);
    if (!result.ok) return error(result.error, result.status, result.code);
    return withCookies(json(await freshPayload(env, next.tokenHash, next.token), 201), sessionCookie(request, next.token));
  }

  if (!session) return error("რვეული ვერ მოიძებნა. განაახლე გვერდი.", 401, "signed-out");

  if (path === "/api/ws" && method === "GET") return forwardToNotebook(request, env, session);
  if ((path === "/api/history" || path === "/api/export") && method === "GET") return forwardToNotebook(request, env, session, false);

  if (path === "/api/members" && method === "POST") {
    if (session.guest) return error("სახელები რეგისტრაციის შემდეგ ემატება.", 400);
    const input = await readJson(request);
    const result = await store.addMember(session.accountId, session.tokenHash, normalizeMemberName(input.name), input.select === true);
    if (!result.ok) return error(result.error, result.status);
    return json({ ...(await freshPayload(env, session.tokenHash, session.token)), added: result.member }, 201);
  }
  const memberMatch = path.match(/^\/api\/members\/([^/]+)$/);
  if (memberMatch && method === "DELETE") {
    if (!isUUID(memberMatch[1])) return error("სახელი ვერ მოიძებნა.", 404);
    await store.removeMember(session.accountId, memberMatch[1]);
    return json(await freshPayload(env, session.tokenHash, session.token));
  }
  if (path === "/api/session/member" && method === "PUT") {
    const input = await readJson(request);
    if (!isUUID(input.memberId)) return error("სახელი ვერ მოიძებნა.", 404);
    const result = await store.selectMember(session.accountId, session.tokenHash, input.memberId);
    if (!result.ok) return error(result.error, result.status);
    return json(await freshPayload(env, session.tokenHash, session.token));
  }
  if (path === "/api/account/password" && method === "POST") {
    if (session.guest) return error("პაროლის დასაყენებლად ჯერ დარეგისტრირდი.", 400);
    const passwordHash = await hashPasswordKey(passwordKeyFrom(await readJson(request)));
    await store.setPassword(session.accountId, passwordHash);
    return json(await freshPayload(env, session.tokenHash, session.token));
  }
  if (path === "/api/account/sign-out-others" && method === "POST") {
    return json({ ok: true, signedOut: await store.signOutOthers(session.accountId, session.tokenHash) });
  }
  if (path === "/api/account/merge" && method === "POST") {
    const keep = (await readJson(request)).keep === true;
    const guestId = session.mergeFrom;
    if (!guestId) return json({ imported: 0, skipped: 0 });
    let result = { imported: 0, skipped: 0 };
    if (keep) {
      const actor = actorOf(session);
      const bookings = await notebook(env, guestId).exportBookings();
      result = await notebook(env, session.accountId).importBookings(bookings, actor.name);
    }
    await store.finishMerge(session.tokenHash, guestId);
    await wipeNotebook(env, guestId);
    return json(result);
  }
  return error("მისამართი ვერ მოიძებნა.", 404, "NOT_FOUND");
}

async function handleAuth(request, env) {
  const url = new URL(request.url);
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  if (url.pathname === "/auth/google") {
    if (!googleReady(env)) return redirect("/?auth=google-off");
    return startGoogle(request, env, url.searchParams.get("mode") === "link" ? "link" : "login");
  }
  if (url.pathname !== "/auth/google/callback") return new Response("Not found", { status: 404 });
  const clear = clearOauthCookie(request);
  if (!googleReady(env)) return redirect("/?auth=google-off", { "Set-Cookie": clear });
  const result = await finishGoogle(request, env);
  if (result.error) return redirect("/?auth=" + result.error, { "Set-Cookie": clear });
  const current = await currentSession(env, request);
  const next = await newToken();
  const outcome = await accounts(env).googleSignIn({
    sub: result.profile.sub,
    email: result.profile.email,
    mode: result.mode,
    currentTokenHash: current?.tokenHash || null,
    newTokenHash: next.tokenHash,
    guestHasData: await guestHasData(env, current)
  });
  if (!outcome.ok) return redirect("/?auth=" + outcome.code, { "Set-Cookie": clear });
  if (outcome.linked) return redirect("/?auth=google-linked", { "Set-Cookie": clear });
  await wipeNotebook(env, outcome.removedGuest);
  return withCookies(new Response(null, { status: 302, headers: { Location: "/", "Cache-Control": "no-store" } }), clear, sessionCookie(request, next.token));
}

export default {
  async fetch(request, env) {
    const moved = publicRedirect(request, env);
    if (moved) return moved;
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      if (request.method !== "GET" || url.pathname.startsWith("/api/")) return error("საჭიროა დაცული HTTPS კავშირი.", 400, "HTTPS_REQUIRED");
      url.protocol = "https:";
      return Response.redirect(url.toString(), 308);
    }
    const api = url.pathname.startsWith("/api/");
    const auth = url.pathname.startsWith("/auth/");
    if (!api && !auth) return env.ASSETS.fetch(request);
    try {
      return api ? await handleApi(request, env) : await handleAuth(request, env);
    } catch (err) {
      if (err instanceof UserError) return error(err.message, err.status, err.code);
      console.error("Request failed", err?.name, err?.message);
      if (auth) return redirect("/?auth=google-failed", { "Set-Cookie": clearOauthCookie(request) });
      return error("სერვერზე შეცდომაა. ჩანაწერი არ წაშლილა; სცადე ხელახლა.", 500, "SERVER_ERROR");
    }
  }
};
