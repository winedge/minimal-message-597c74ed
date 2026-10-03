import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function assertAdmin(ctx: any) {
  const { data: isAdmin } = await ctx.supabase.rpc("has_role", {
    _user_id: ctx.userId,
    _role: "admin",
  });
  if (!isAdmin) throw new Error("Forbidden");
}

function twilioAuth() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN missing)");
  return { sid, token, header: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64") };
}

export const listTwilioNumbers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { sid, header } = twilioAuth();

    const numbers: { sid: string; phone_number: string; status: string | null; tag: string | null; voice_url: string | null; status_callback: string | null }[] = [];
    let url: string | null = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`;
    let guard = 0;
    while (url && guard++ < 20) {
      const res: Response = await fetch(url, { headers: { Authorization: header, Accept: "application/json" } });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Twilio API ${res.status}: ${body}`);
      }
      const json: any = await res.json();
      for (const it of json.incoming_phone_numbers ?? []) {
        numbers.push({
          sid: it.sid,
          phone_number: it.phone_number,
          status: it.status ?? null,
          tag: it.friendly_name ?? null,
          voice_url: it.voice_url ?? null,
          status_callback: it.status_callback ?? null,
        });
      }
      url = json.next_page_uri ? `https://api.twilio.com${json.next_page_uri}` : null;
    }
    return numbers;
  });

export const syncTwilioWebhooks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        phone_numbers: z.array(z.string()).optional(), // if omitted, apply to all
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { sid, header } = twilioAuth();

    const base = (process.env.PUBLIC_WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");
    if (!base) throw new Error("PUBLIC_WEBHOOK_BASE_URL not configured");

    const voiceUrl = `${base}/api/public/twilio-inbound`;
    const statusUrl = `${base}/api/public/twilio-status`;

    // Fetch all numbers
    const all: { sid: string; phone_number: string }[] = [];
    let url: string | null = `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`;
    let guard = 0;
    while (url && guard++ < 20) {
      const res: Response = await fetch(url, { headers: { Authorization: header, Accept: "application/json" } });
      if (!res.ok) throw new Error(`Twilio API ${res.status}: ${await res.text()}`);
      const json: any = await res.json();
      for (const it of json.incoming_phone_numbers ?? []) {
        all.push({ sid: it.sid, phone_number: it.phone_number });
      }
      url = json.next_page_uri ? `https://api.twilio.com${json.next_page_uri}` : null;
    }

    const filter = data.phone_numbers && data.phone_numbers.length > 0 ? new Set(data.phone_numbers) : null;
    const targets = filter ? all.filter((n) => filter.has(n.phone_number)) : all;

    const results: { phone_number: string; ok: boolean; error?: string }[] = [];
    for (const n of targets) {
      const body = new URLSearchParams({
        VoiceUrl: voiceUrl,
        VoiceMethod: "POST",
        StatusCallback: statusUrl,
        StatusCallbackMethod: "POST",
      });
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers/${n.sid}.json`,
        {
          method: "POST",
          headers: {
            Authorization: header,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body,
        },
      );
      if (!res.ok) {
        results.push({ phone_number: n.phone_number, ok: false, error: `${res.status}: ${await res.text()}` });
      } else {
        results.push({ phone_number: n.phone_number, ok: true });
      }
    }

    return {
      voice_url: voiceUrl,
      status_url: statusUrl,
      updated: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      results,
    };
  });

export const syncTwilioTwimlApp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { sid, header } = twilioAuth();

    const appSid = process.env.TWILIO_TWIML_APP_SID;
    if (!appSid) throw new Error("TWILIO_TWIML_APP_SID not configured");

    const base = (process.env.PUBLIC_WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");
    if (!base) throw new Error("PUBLIC_WEBHOOK_BASE_URL not configured");

    const voiceUrl = `${base}/api/public/twilio-voice`;
    const statusUrl = `${base}/api/public/twilio-status`;

    const body = new URLSearchParams({
      VoiceUrl: voiceUrl,
      VoiceMethod: "POST",
      StatusCallback: statusUrl,
      StatusCallbackMethod: "POST",
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Applications/${appSid}.json`,
      {
        method: "POST",
        headers: {
          Authorization: header,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      },
    );
    if (!res.ok) throw new Error(`Twilio API ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return {
      app_sid: appSid,
      friendly_name: json.friendly_name ?? null,
      voice_url: json.voice_url ?? voiceUrl,
      status_callback: json.status_callback ?? statusUrl,
    };
  });


// ---- Buy numbers ----
export const searchTwilioAvailableNumbers = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        country: z.string().trim().length(2).toUpperCase(),
        type: z.enum(["Local", "TollFree"]).default("Local"),
        areaCode: z.string().trim().regex(/^\d{3}$/).optional().or(z.literal("")),
        contains: z.string().trim().regex(/^[0-9*]{1,10}$/).optional().or(z.literal("")),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { sid, header } = twilioAuth();
    const qs = new URLSearchParams({ VoiceEnabled: "true", PageSize: "20" });
    if (data.areaCode) qs.set("AreaCode", data.areaCode);
    if (data.contains) qs.set("Contains", data.contains);
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/AvailablePhoneNumbers/${data.country}/${data.type}.json?${qs}`,
      { headers: { Authorization: header, Accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`Twilio API ${res.status}: ${await res.text()}`);
    const json: any = await res.json();
    return (json.available_phone_numbers ?? []).map((n: any) => ({
      phone_number: n.phone_number as string,
      friendly_name: (n.friendly_name ?? n.phone_number) as string,
      locality: (n.locality ?? null) as string | null,
      region: (n.region ?? null) as string | null,
    }));
  });

export const buyTwilioNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        phone_number: z.string().trim().regex(/^\+[1-9]\d{6,14}$/, "Use E.164 e.g. +14155551234"),
        label: z.string().trim().max(64).optional().nullable(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context);
    const { sid, header } = twilioAuth();
    const body = new URLSearchParams({ PhoneNumber: data.phone_number });
    if (data.label) body.set("FriendlyName", data.label);
    const base = (process.env.PUBLIC_WEBHOOK_BASE_URL ?? "").replace(/\/$/, "");
    if (base) {
      body.set("VoiceUrl", `${base}/api/public/twilio-inbound`);
      body.set("VoiceMethod", "POST");
      body.set("StatusCallback", `${base}/api/public/twilio-status`);
      body.set("StatusCallbackMethod", "POST");
    }
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json`, {
      method: "POST",
      headers: {
        Authorization: header,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    if (!res.ok) {
      let msg = await res.text();
      try { msg = JSON.parse(msg).message ?? msg; } catch { /* keep raw */ }
      throw new Error(`Twilio ${res.status}: ${msg}`);
    }
    const json: any = await res.json();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("outbound_dids")
      .upsert({ phone_number: json.phone_number, label: data.label ?? null }, { onConflict: "phone_number" });
    return { sid: json.sid as string, phone_number: json.phone_number as string, webhooksConfigured: !!base };
  });
