// Sign-in helpers: password keys, session cookies, same-origin checks,
// Google sign-in and the redirect to the public pages.dev address.
// (Same helpers as the orders notebook.)

const encoder = new TextEncoder();

export const SESSION_MS = 400 * 86400000;
export const SESSION_COOKIE = 'session';
const OAUTH_COOKIE = 'google_oauth';
// The browser stretches the password (see public/password.mjs) and sends a
// 256-bit key. The server stretches that key again with a random salt, so a
// leaked database still needs both stretches per guess.
export const SERVER_ITERATIONS = 20000;

export class UserError extends Error {
  constructor(message, status = 400, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function b64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

export function randomToken(byteLength = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function equalStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function validPasswordKey(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function stretch(key, salt, iterations) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(key), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({name: 'PBKDF2', hash: 'SHA-256', salt, iterations}, material, 256);
  return b64url(new Uint8Array(bits));
}

export async function hashPasswordKey(key, iterations = SERVER_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${iterations}$${b64url(salt)}$${await stretch(key, salt, iterations)}`;
}

export async function verifyPasswordKey(key, stored) {
  if (!validPasswordKey(key) || typeof stored !== 'string') return false;
  const [scheme, rounds, salt, expected] = stored.split('$');
  const iterations = Number(rounds);
  if (scheme !== 'pbkdf2' || !Number.isSafeInteger(iterations) || iterations < 1000 || iterations > 100000 || !salt || !expected) return false;
  return equalStrings(await stretch(key, fromB64url(salt), iterations), expected);
}

export function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length < 5 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new UserError('ელფოსტა სწორად ჩაწერე, მაგალითად: nino@gmail.com');
  }
  return email;
}

export function normalizeMemberName(value) {
  const name = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new UserError('სახელი ჩაწერე.');
  if (name.length > 40) throw new UserError('სახელი ძალიან გრძელია. მაქსიმუმ 40 სიმბოლო.');
  return name;
}

const secure = request => new URL(request.url).protocol === 'https:';

export function sessionCookie(request, token, maxAgeSeconds = SESSION_MS / 1000) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure(request) ? '; Secure' : ''}`;
}

export function clearSessionCookie(request) {
  return sessionCookie(request, '', 0);
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

export function readSessionToken(request) {
  const token = readCookie(request, SESSION_COOKIE);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

// Requests that change data must come from our own page.
export function sameOrigin(request) {
  const url = new URL(request.url);
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site') return false;
  const origin = request.headers.get('Origin');
  return !origin || origin === url.origin;
}

export async function readJson(request, limit = 16384) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.toLowerCase().startsWith('application/json')) throw new UserError('ინფორმაცია არასწორ ფორმატშია.', 415);
  if (Number(request.headers.get('Content-Length') || 0) > limit) throw new UserError('ინფორმაცია ძალიან დიდია.', 413);
  const text = await request.text();
  if (text.length > limit) throw new UserError('ინფორმაცია ძალიან დიდია.', 413);
  try {
    const value = JSON.parse(text || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new UserError('ინფორმაცია არასწორ ფორმატშია.');
  }
}

export function json(data, status = 200, headers = {}) {
  return Response.json(data, {
    status,
    headers: {'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers}
  });
}

export function redirect(location, headers = {}) {
  return new Response(null, {status: 302, headers: {Location: location, 'Cache-Control': 'no-store', ...headers}});
}

// The Worker keeps running in the background (daily reminders, data), but
// people should only ever see the pages.dev address.
export function publicRedirect(request, env) {
  if (!env.PUBLIC_URL) return null;
  const url = new URL(request.url);
  let target;
  try { target = new URL(env.PUBLIC_URL); } catch { return null; }
  if (url.hostname === target.hostname || !url.hostname.endsWith('.workers.dev')) return null;
  return redirect(target.origin + url.pathname + url.search);
}

// ---- Google sign-in (OAuth 2.0 authorization code flow with PKCE) ----

export function googleReady(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function googleRedirectUri(request) {
  return new URL('/auth/google/callback', request.url).toString();
}

export async function startGoogle(request, env, mode) {
  const state = randomToken(16);
  const verifier = randomToken(32);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))));
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(request),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'select_account'
  });
  const cookie = `${OAUTH_COOKIE}=${state}.${verifier}.${mode === 'link' ? 'link' : 'login'}; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${secure(request) ? '; Secure' : ''}`;
  return redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params, {'Set-Cookie': cookie});
}

export function clearOauthCookie(request) {
  return `${OAUTH_COOKIE}=; Path=/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${secure(request) ? '; Secure' : ''}`;
}

export function readOauthState(request) {
  const value = readCookie(request, OAUTH_COOKIE);
  const match = value && value.match(/^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})\.(login|link)$/);
  return match ? {state: match[1], verifier: match[2], mode: match[3]} : null;
}

export function profileFromIdToken(idToken, clientId, now = Date.now()) {
  const parts = typeof idToken === 'string' ? idToken.split('.') : [];
  if (parts.length !== 3) throw new Error('Malformed ID token');
  const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') throw new Error('Wrong issuer');
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) throw new Error('Wrong audience');
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 < now - 60000) throw new Error('Expired token');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) throw new Error('Missing subject');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new Error('Email not verified');
  return {sub: claims.sub, email: normalizeEmail(claims.email), name: typeof claims.name === 'string' ? claims.name.slice(0, 80) : ''};
}

// The ID token comes straight from Google's token endpoint over TLS, so the
// claims are checked without verifying the signature (OpenID Connect 3.1.3.7).
export async function finishGoogle(request, env, fetcher = fetch) {
  const url = new URL(request.url);
  const saved = readOauthState(request);
  if (url.searchParams.get('error')) return {error: 'google-cancelled', mode: saved?.mode || 'login'};
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!saved || !equalStrings(state, saved.state) || !code || code.length > 2048) return {error: 'google-failed', mode: saved?.mode || 'login'};
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: googleRedirectUri(request),
      grant_type: 'authorization_code',
      code_verifier: saved.verifier
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) return {error: 'google-failed', mode: saved.mode};
  const tokens = await response.json();
  try {
    return {profile: profileFromIdToken(tokens.id_token, env.GOOGLE_CLIENT_ID), mode: saved.mode};
  } catch {
    return {error: 'google-failed', mode: saved.mode};
  }
}
