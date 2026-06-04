// Supabase Edge Function: send-ticket-sms
// Sends a one-way SMS to a customer via ClickSend (an Australian SMS
// provider). The ClickSend credentials live in Supabase secrets, never
// in the public dashboard page.
//
// Deploy:
//   supabase functions deploy send-ticket-sms --project-ref ebqiitxiyzzbkgyfypss
// Secrets (set once):
//   supabase secrets set CLICKSEND_USERNAME=you@example.com \
//                        CLICKSEND_API_KEY=xxxxxxxx \
//                        CLICKSEND_SENDER=ChatswdVlt \
//                        --project-ref ebqiitxiyzzbkgyfypss
//
// Request body:  { "to": "0433273377", "message": "..." }
// Response:      { "ok": true, "status": "SUCCESS" }  (or ok:false + error)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const USERNAME = Deno.env.get("CLICKSEND_USERNAME") ?? "";
const API_KEY = Deno.env.get("CLICKSEND_API_KEY") ?? "";
// Alphanumeric sender ID — max 11 chars, free in Australia, one-way only.
const SENDER = Deno.env.get("CLICKSEND_SENDER") ?? "ChatswdVlt";

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

// Normalise an Australian mobile to E.164 (+61…). Accepts "0433 273 377",
// "0433273377", "+61433273377", "61433273377".
function toE164AU(raw: string): string {
  let n = String(raw).replace(/[^\d+]/g, "");
  if (n.startsWith("+")) return n;
  if (n.startsWith("0")) return "+61" + n.slice(1);
  if (n.startsWith("61")) return "+" + n;
  return "+61" + n;
}

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "POST only" }, 405);

  if (!USERNAME || !API_KEY) {
    return json({ ok: false, error: "SMS not configured (missing ClickSend secrets)" }, 503);
  }

  let to = "", message = "";
  try {
    const body = await req.json();
    to = (body.to ?? "").toString().trim();
    message = (body.message ?? "").toString();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }
  if (!to || !message) return json({ ok: false, error: "missing 'to' or 'message'" }, 400);

  const number = toE164AU(to);

  try {
    const res = await fetch("https://rest.clicksend.com/v3/sms/send", {
      method: "POST",
      headers: {
        "Authorization": "Basic " + btoa(`${USERNAME}:${API_KEY}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [{ source: "valet", from: SENDER, to: number, body: message }],
      }),
    });
    const data = await res.json();
    const m = data?.data?.messages?.[0];
    const status = m?.status ?? data?.response_code ?? "UNKNOWN";
    const ok = res.ok && typeof status === "string" &&
      /success|queued|sent/i.test(status);
    return json({ ok, status, cost: m?.message_price, raw: ok ? undefined : data }, ok ? 200 : 502);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502);
  }
});
