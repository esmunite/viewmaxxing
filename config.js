/* GET /api/config — public-safe client config.
   The anon key is designed to be public (it's in every Supabase JS app);
   all real secrets (service role, Gemini, Groq) stay in server env only. */
'use strict';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY)
    return res.status(500).json({ error: 'not_configured' });
  return res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY
  });
};
