// Supabase Edge Function "ai": Hustl AI, answered by Google Gemini.
// Deploy:  npx supabase functions deploy ai --remote=<ref> --no-verify-jwt --use-api
// Secrets: GEMINI_API_KEY (required), GEMINI_MODELS (optional, comma-separated order; default in core.mjs), AI_DAILY_LIMIT (optional, default 1000)
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase; the keys stay on the server.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handle } from './core.mjs';

const env = (k: string) => Deno.env.get(k) ?? '';
const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false, autoRefreshToken: false } });

Deno.serve(req => handle(req, {
  env: { GEMINI_API_KEY: env('GEMINI_API_KEY'), GEMINI_MODELS: env('GEMINI_MODELS'), DAILY_LIMIT: env('AI_DAILY_LIMIT') },
  fetch: (url: string, init: RequestInit) => fetch(url, init),
  async userFromToken(jwt: string) { const { data } = await sb.auth.getUser(jwt); return data?.user ?? null; },
  // counts one message; null when today's limit is already used up
  async takeMessage(userId: string, limit: number) {
    const { data, error } = await sb.rpc('ai_take_message', { p_user: userId, p_limit: limit });
    if (error) { console.error('ai_take_message', error.message); return 1; }   // counting failed: don't block the person
    return data ?? null;
  },
}));
