// Supabase Edge Function: weekly-digest
// Triggered by a cron schedule (Saturday 10:00) — see /supabase/README.md for setup.
// Reads the past 7 days of notes, asks Gemini for a thematic summary,
// writes the result to `digests`, and (optionally) sends a Web Push notification.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

function startOfWeekWindow(now = new Date()) {
  // 7-day window ending "now" (the Saturday 10am run time)
  const end = new Date(now);
  const start = new Date(now);
  start.setDate(start.getDate() - 7);
  return { start, end };
}

async function buildDigestPrompt(notes: any[]) {
  const lines = notes.map((n) => {
    const cat = n.categories?.name ?? "Uncategorised";
    return `- [${cat} / ${n.source_type}] "${n.quote}" — context: ${n.context ?? "none"} (${n.link ?? "no link"})`;
  });

  return `You are summarising one week of reading notes for a single reader.
Below is a list of quotes they saved this week, each tagged with its category and source type.

${lines.join("\n")}

Write a short thematic digest (150-250 words):
1. Identify 2-4 real themes or connections across these notes — not just one summary sentence per category.
2. Note any surprising links between categories that don't obviously belong together.
3. Keep the tone plain and direct, no filler, no "In this digest we will..." preamble.
4. If the notes are too sparse or unrelated to find themes, say so plainly rather than forcing connections.

Return plain text only, no markdown headers.`;
}

async function callGemini(prompt: string): Promise<string> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    }
  );
  if (!resp.ok) {
    throw new Error(`Gemini API error: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "No summary generated.";
}

Deno.serve(async (_req) => {
  try {
    const { start, end } = startOfWeekWindow();

    // Single-user assumption for now — fetch all users with notes in the window.
    // If you extend to multi-user, loop over distinct user_ids instead.
    const { data: notes, error } = await supabase
      .from("notes")
      .select("id, quote, link, source_type, context, category_id, user_id, categories(name)")
      .gte("created_at", start.toISOString())
      .lte("created_at", end.toISOString())
      .order("created_at", { ascending: true });

    if (error) throw error;

    if (!notes || notes.length === 0) {
      return new Response(JSON.stringify({ message: "No notes this week — skipping digest." }), {
        status: 200,
      });
    }

    // Group by user in case of future multi-user use
    const byUser = new Map<string, any[]>();
    for (const n of notes) {
      if (!byUser.has(n.user_id)) byUser.set(n.user_id, []);
      byUser.get(n.user_id)!.push(n);
    }

    const results = [];
    for (const [userId, userNotes] of byUser) {
      const prompt = await buildDigestPrompt(userNotes);
      const summary = await callGemini(prompt);

      const { error: insertError } = await supabase.from("digests").upsert(
        {
          user_id: userId,
          week_start: start.toISOString().slice(0, 10),
          week_end: end.toISOString().slice(0, 10),
          summary,
          note_count: userNotes.length,
        },
        { onConflict: "user_id,week_start" }
      );
      if (insertError) throw insertError;

      // Web Push notification hook — wire in a push subscription table
      // and call your push-send logic here once notifications are set up.

      results.push({ userId, noteCount: userNotes.length });
    }

    return new Response(JSON.stringify({ digestsCreated: results }), { status: 200 });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
