// The pages.dev front door. Every request (including the live-sync WebSocket
// on /api/ws) goes to the "cotage-notepad" Worker, which serves the site itself,
// the notebooks and Google sign-in. Updating the Worker (for example from
// GitHub) therefore updates this address too.
export default {
  async fetch(request, env) {
    if (!env.API) {
      return new Response("საიტს Cloudflare-ზე გამართვა სჭირდება.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    return env.API.fetch(request);
  },
};
