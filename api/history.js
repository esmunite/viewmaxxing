/* GET /api/history — the authenticated user's recent reports (newest first). */
'use strict';

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    var user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    var r = await fetch(
      process.env.SUPABASE_URL + '/rest/v1/reports?user_id=eq.' + encodeURIComponent(user.id) +
      '&select=id,created_at,brief,report&order=created_at.desc&limit=30',
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
        },
        signal: AbortSignal.timeout(10000)
      }
    );
    if (!r.ok) return res.status(500).json({ error: 'history_failed' });
    return res.status(200).json(await r.json());
  } catch (e) {
    return res.status(500).json({ error: 'history_failed' });
  }
};

async function getUser(req) {
  var h = req.headers.authorization || '';
  var token = h.indexOf('Bearer ') === 0 ? h.slice(7) : null;
  if (!token) return null;
  var r = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
    headers: { apikey: process.env.SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) return null;
  var j = await r.json();
  return j && j.id ? j : null;
}
