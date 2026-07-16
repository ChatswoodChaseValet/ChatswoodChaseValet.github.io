// Supabase Edge Function: pr-usage
// Server-side proxy for Plate Recognizer's usage/statistics endpoint. The browser
// CANNOT call https://api.platerecognizer.com/v1/statistics/ directly — that
// endpoint sends no CORS header, so the fetch fails with "Failed to fetch". This
// relays the call server-side (no CORS) and returns just the counts.
//
// Request:  { "token": "<plate recognizer API token>" }
// Response: { ok, calls, total_calls, resets_on }  |  { ok:false, error }
//
// SECURITY: requires a logged-in staff session (JWT role "authenticated"), so it
// can't be used as an open proxy. The token is supplied by the caller (it already
// lives in the dashboard/driveway config) and only relayed to Plate Recognizer.
//
// Deploy:
//   supabase functions deploy pr-usage --project-ref ebqiitxiyzzbkgyfypss

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function jwtRole(authHeader: string): string {
  try {
    const tok = authHeader.replace(/^Bearer\s+/i, "");
    const seg = tok.split(".")[1];
    const payload = JSON.parse(
      atob(seg.replace(/-/g, "+").replace(/_/g, "/").padEnd(seg.length + (4 - (seg.length % 4)) % 4, "=")),
    );
    return payload?.role ?? "";
  } catch {
    return "";
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (jwtRole(req.headers.get("Authorization") ?? "") !== "authenticated") {
    return json({ ok: false, error: "staff login required" }, 401);
  }

  let token = "";
  try {
    const body = await req.json();
    token = (body.token ?? "").toString().trim();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (!token) return json({ ok: false, error: "missing token" }, 400);

  try {
    const r = await fetch("https://api.platerecognizer.com/v1/statistics/", {
      headers: { "Authorization": "Token " + token },
    });
    if (r.status === 401 || r.status === 403) {
      return json({ ok: false, error: "Token rejected — check it's correct" });
    }
    if (!r.ok) {
      return json({ ok: false, error: "Plate Recognizer HTTP " + r.status });
    }
    const d = await r.json();
    // Real shape: { total_calls: <monthly limit>, usage: { calls: <used>, resets_on } }
    return json({
      ok: true,
      calls: d?.usage?.calls ?? 0,
      total_calls: d?.total_calls ?? null,
      resets_on: d?.usage?.resets_on ?? null,
    });
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
});
