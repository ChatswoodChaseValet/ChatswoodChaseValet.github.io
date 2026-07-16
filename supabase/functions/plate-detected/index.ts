// Supabase Edge Function: plate-detected
// The "letterbox" for the driveway ANPR camera. A camera (or the driveway.html
// phone page) POSTs a plate it just read; this function looks the plate up in
// the customer history + pre-registered list and, if it's a known car, pushes
// an arrival alert to every opted-in staff phone — so the valet knows a
// returning customer just pulled in, before they step out of the car.
//
// Request body:
//   { "plate": "NHK42J", "confidence": 0.94, "camera": "driveway-1", "secret": "..." }
//     - plate      : the read plate text (any casing/spacing; we normalise)
//     - confidence : 0..1 optional, from the OCR
//     - camera     : optional label of which camera/lane
//     - secret     : optional shared secret; enforced only if one is configured
//
// Response:
//   { ok, matched, plate, name?, brand?, model?, visit_count?, on_site?, bay?,
//     vip?, source?, pushed, deduped? }
//
// SECURITY: a logged-in STAFF SESSION is required (JWT role must be
// "authenticated"). The public anon key alone is rejected — number plates are
// visible on every car, so looking up who owns one must never be reachable
// without staff auth. This keeps the driveway feature inside the same Phase-2
// PII lockdown as the rest of the app. The driveway page logs in via staff-auth
// (same as the dashboard) to obtain that session. An OPTIONAL shared secret
// (app_config.plate_detect, service-role only) can be added as a second layer.
//
// Trust model (mirrors notify-pickup): the LOOKUP and the push run under the
// SERVICE ROLE, so the customer details in the alert come from the database,
// never from the caller — the caller only supplies a plate string.
//
// Deploy:
//   supabase functions deploy plate-detected --project-ref ebqiitxiyzzbkgyfypss

import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

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

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Ignore repeat reads of the same plate inside this window — a driveway camera
// sees the same car for many seconds; we only want ONE alert per arrival.
const COOLDOWN_SECONDS = 90;

// Same rule as normaliseRego() in the app: upper-case, drop anything that
// isn't a letter or digit (spaces, hyphens, underscores, dots).
function normPlate(s: string): string {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Read the role claim from the caller's JWT. verify_jwt=true means the gateway
// has already validated the signature before we run, so the claim is trustworthy.
// The public anon key is role="anon"; a logged-in staff session is
// role="authenticated". We require the latter — plates are visible on every car,
// so returning who owns one must never be reachable with the public key alone.
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

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid JSON body" }, 400);
  }

  // ── Gate: a logged-in staff session is required. The public anon key must
  //    NOT be able to look up who owns a plate. ──
  if (jwtRole(req.headers.get("Authorization") ?? "") !== "authenticated") {
    return json({ ok: false, error: "staff login required" }, 401);
  }

  const plateRaw = (body.plate ?? "").toString().trim();
  const plate_norm = normPlate(plateRaw);
  const confidence = body.confidence != null ? Number(body.confidence) : null;
  const camera = (body.camera ?? "").toString().trim() || null;
  const secret = (body.secret ?? "").toString();

  if (plate_norm.length < 3) {
    return json({ ok: true, matched: false, ignored: "plate too short", plate: plateRaw });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // Optional shared secret — enforced only when one has been configured.
  const { data: sec } = await admin
    .from("app_config").select("value").eq("key", "plate_detect").maybeSingle();
  const expected = (sec?.value as { secret?: string } | null)?.secret;
  if (expected && expected !== secret) {
    return json({ ok: false, error: "unauthorised" }, 401);
  }

  // De-dupe: same plate seen very recently → don't alert again.
  const since = new Date(Date.now() - COOLDOWN_SECONDS * 1000).toISOString();
  const { data: recent } = await admin
    .from("plate_detections")
    .select("id, matched, customer_name, detected_at")
    .eq("plate_norm", plate_norm)
    .gte("detected_at", since)
    .order("detected_at", { ascending: false })
    .limit(1);
  if (recent && recent.length) {
    return json({
      ok: true, deduped: true, plate: plateRaw,
      matched: recent[0].matched, name: recent[0].customer_name,
    });
  }

  // Look the plate up (history + pre-registered), all in SQL under the service role.
  const { data: look, error: lookErr } = await admin.rpc("lookup_plate", { p_norm: plate_norm });
  if (lookErr) {
    console.error(`[plate-detected] lookup_plate error: ${lookErr.message}`);
  }
  const m = (look ?? { matched: false }) as {
    matched: boolean; source?: string; entry_id?: string; name?: string;
    brand?: string; model?: string; rego?: string; vip?: boolean;
    visit_count?: number; on_site?: boolean; bay?: string;
  };

  // Record the detection (feeds a future "arrivals" list on the dashboard, and
  // powers the de-dupe above).
  await admin.from("plate_detections").insert({
    plate: plateRaw,
    plate_norm,
    confidence,
    camera,
    matched: !!m.matched,
    entry_id: m.entry_id ?? null,
    customer_name: m.name ?? null,
    visit_count: m.visit_count ?? null,
    on_site: m.on_site ?? false,
    vip: m.vip ?? false,
  });

  let pushed = 0;
  if (m.matched) {
    pushed = await pushArrival(admin, plateRaw, m);
  }

  console.log(`[plate-detected] plate=${plate_norm} matched=${m.matched} on_site=${m.on_site ?? false} pushed=${pushed}`);
  return json({ ok: true, plate: plateRaw, ...m, pushed });
});

// ── Push an arrival alert to every opted-in staff device (mirrors notify-pickup) ──
async function pushArrival(
  admin: ReturnType<typeof createClient>,
  plate: string,
  m: { name?: string; brand?: string; model?: string; vip?: boolean;
       visit_count?: number; on_site?: boolean; bay?: string; source?: string },
): Promise<number> {
  const { data: cfg } = await admin
    .from("app_config").select("value").eq("key", "vapid").maybeSingle();
  const vapid = cfg?.value as { publicKey: string; privateKey: string; subject: string } | undefined;
  if (!vapid?.privateKey) {
    console.error("[plate-detected] VAPID config missing — cannot push");
    return 0;
  }
  webpush.setVapidDetails(vapid.subject || "mailto:valet@example.com", vapid.publicKey, vapid.privateKey);

  const car = [m.brand, m.model].filter(Boolean).join(" ");
  const bits: string[] = [];
  if (car) bits.push(car);
  if (m.on_site && m.bay) bits.push(`car on-site · Bay ${m.bay}`);
  else if (m.source === "pre_registered") bits.push("pre-registered");
  else if (m.visit_count) bits.push(`${m.visit_count} ${m.visit_count === 1 ? "visit" : "visits"}`);
  if (m.vip) bits.push("⭐ VIP");

  const title = m.on_site
    ? `🚗 ${m.name || plate} returning — Bay ${m.bay ?? "?"}`
    : `🚗 Returning customer at driveway`;
  const line1 = `${plate}${m.name ? " · " + m.name : ""}`;

  const payload = JSON.stringify({
    title,
    body: `${line1}\n${bits.join(" · ")}`.trim(),
    tag: `arrival-${normPlate(plate)}`, // collapses repeat alerts for the same car
  });

  const { data: subs } = await admin
    .from("push_subscriptions").select("id, endpoint, p256dh, auth");
  if (!subs || subs.length === 0) return 0;

  let sent = 0;
  const dead: string[] = [];
  await Promise.all(subs.map(async (s: any) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 300, urgency: "high" },
      );
      sent++;
    } catch (err: any) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) dead.push(s.id);
    }
  }));
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  return sent;
}
