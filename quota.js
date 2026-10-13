/* GET /api/quota — { remaining, limit } for the authenticated user (UTC day). */
'use strict';

var LIMIT = 3;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    var user = await getUser(req);
    if (!user) return res.status(401).json({ error: 'unauthorized' });
    var day = new Date().toISOString().slice(0, 10);
    var used = await getUsage(user.id, day);
    return res.status(200).json({ remaining: Math.max(0, LIMIT - used), limit: LIMIT });
  } catch (e) {
    return res.status(500).json({ error: 'quota_failed' });
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

async function getUsage(userId, day) {
  var r = await fetch(
    process.env.SUPABASE_URL + '/rest/v1/usage?user_id=eq.' + encodeURIComponent(userId) +
    '&day=eq.' + day + '&select=count',
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY
      },
      signal: AbortSignal.timeout(10000)
    }
  );
  if (!r.ok) return 0;
  var rows = await r.json();
  return rows.length ? rows[0].count : 0;
}
