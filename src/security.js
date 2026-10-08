import { AppError } from "./domain.js";
const encoder = new TextEncoder();
export function randomToken(length = 32) {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(length)))
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
export function equal(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
export async function digest(value) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value))
    ),
    (b) => b.toString(16).padStart(2, "0")
  ).join("");
}
export function validPin(pin) {
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin))
    throw new AppError("კოდი ზუსტად 4 ციფრი უნდა იყოს.");
}
export async function pinHash(pin, salt) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 100000
    },
    key,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}
export function checkOrigin(request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    throw new AppError("მოთხოვნის წყარო დაუშვებელია.", "ORIGIN", 403);
}
export async function readJSON(request, maxBytes = 24000) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError("საჭიროა JSON ფორმატი.", "CONTENT_TYPE", 415);
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new AppError("მოთხოვნა მეტისმეტად დიდია.", "TOO_LARGE", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("მოთხოვნა ცარიელია.");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new AppError("მოთხოვნა მეტისმეტად დიდია.", "TOO_LARGE", 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let result;
  try {
    result = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError("JSON არასწორია.");
  }
  if (!result || typeof result !== "object" || Array.isArray(result))
    throw new AppError("JSON ობიექტი აუცილებელია.");
  return result;
}
export function cookieName(request) {
  return new URL(request.url).protocol === "https:"
    ? "__Host-cottage-session"
    : "cottage-session";
}
export function getSessionToken(request) {
  const name = cookieName(request);
  return (
    (request.headers.get("cookie") || "")
      .split(";")
      .map((p) => p.trim())
      .find((p) => p.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ""
  );
}
export function sessionCookie(request, token, age = 2592000) {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === "https:" ? "; Secure" : ""}`;
}
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      ...extra
    }
  });
}
