import { AppError } from "./domain.js";

export function checkOrigin(request) {
  if (request.headers.get("Origin") !== new URL(request.url).origin)
    throw new AppError("მოთხოვნის წყარო დაუშვებელია.", "ORIGIN", 403);
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
