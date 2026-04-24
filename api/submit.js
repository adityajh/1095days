import { neon } from '@neondatabase/serverless';

let _sql;
const getSql = () => (_sql ||= neon(process.env.NEON_DATABASE_URL));

let cachedToken = null;

async function getZohoAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
  const res = await fetch(`${process.env.ZOHO_ACCOUNTS_HOST}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
    }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Zoho token refresh failed: ${JSON.stringify(json)}`);
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return cachedToken.value;
}

async function upsertZohoLead(payload) {
  const token = await getZohoAccessToken();
  const firstName = (payload.firstName || '').trim();
  const lastName = (payload.lastName || '').trim() || 'Unknown';
  const description = `1095 Match = ${payload.matchPct ?? '—'}%`;

  const record = {
    Last_Name: lastName,
    Email: payload.email,
    City: payload.city || null,
    Description: description,
  };
  if (firstName) record.First_Name = firstName;

  const upsertRes = await fetch(`${process.env.ZOHO_API_HOST}/crm/v2/Leads/upsert`, {
    method: 'POST',
    headers: { 'Authorization': `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      data: [record],
      duplicate_check_fields: ['Email'],
      trigger: ['workflow'],
    }),
  });
  const upsertJson = await upsertRes.json();
  const row = upsertJson?.data?.[0];
  if (row?.code !== 'SUCCESS') throw new Error(`Zoho upsert failed: ${JSON.stringify(upsertJson)}`);
  const leadId = row.details.id;
  const action = row.action;

  try {
    const tagRes = await fetch(
      `${process.env.ZOHO_API_HOST}/crm/v2/Leads/${leadId}/actions/add_tags?tag_names=1095days&over_write=false`,
      { method: 'POST', headers: { 'Authorization': `Zoho-oauthtoken ${token}` } },
    );
    const tagJson = await tagRes.json();
    const tagRow = tagJson?.data?.[0];
    if (tagRow?.code !== 'SUCCESS') console.warn('Zoho tag add non-fatal failure', tagJson);
  } catch (e) {
    console.warn('Zoho tag add threw (non-fatal)', e);
  }

  return { leadId, action };
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const firstName = (body.firstName || '').toString().trim();
  const lastName = (body.lastName || '').toString().trim();
  const email = (body.email || '').toString().trim().toLowerCase();

  if (!firstName || !lastName || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ ok: false, error: 'first name, last name, and valid email required' });
    return;
  }

  const record = {
    firstName,
    lastName,
    email,
    city: (body.city || '').toString().trim() || null,
    status: (body.status || '').toString().trim() || null,
    sliderValues: body.sliderValues ? JSON.stringify(body.sliderValues) : null,
    mcqPicks: body.mcqPicks ? JSON.stringify(body.mcqPicks) : null,
    topMatch: body.topMatch || null,
    matchPct: Number.isFinite(body.matchPct) ? body.matchPct : null,
    readinessPct: Number.isFinite(body.readinessPct) ? body.readinessPct : null,
    workDays21: Number.isFinite(body.workDays21) ? body.workDays21 : null,
    shareUrl: body.shareUrl || null,
    userAgent: req.headers['user-agent'] || null,
    referrer: body.referrer || req.headers['referer'] || null,
    ip: getClientIp(req),
  };

  const sql = getSql();
  const [neonResult, zohoResult] = await Promise.allSettled([
    sql`
      insert into submissions
        (first_name, last_name, email, city, status, slider_values, mcq_picks, top_match,
         match_pct, readiness_pct, work_days_21, share_url, user_agent, referrer, ip)
      values
        (${record.firstName}, ${record.lastName}, ${record.email}, ${record.city}, ${record.status},
         ${record.sliderValues}, ${record.mcqPicks}, ${record.topMatch},
         ${record.matchPct}, ${record.readinessPct}, ${record.workDays21},
         ${record.shareUrl}, ${record.userAgent}, ${record.referrer}, ${record.ip})
      returning id
    `,
    upsertZohoLead(record),
  ]);

  const neonOk = neonResult.status === 'fulfilled';
  const zohoOk = zohoResult.status === 'fulfilled';
  const submissionId = neonOk ? neonResult.value?.[0]?.id ?? null : null;
  const zohoLeadId = zohoOk ? zohoResult.value?.leadId ?? null : null;
  const zohoAction = zohoOk ? zohoResult.value?.action ?? null : null;

  if (neonOk && zohoOk && submissionId && zohoLeadId) {
    try {
      await sql`update submissions set zoho_lead_id = ${zohoLeadId} where id = ${submissionId}`;
    } catch (e) {
      console.error('neon zoho_lead_id update failed', e);
    }
  }

  if (!neonOk) console.error('neon insert failed', neonResult.reason);
  if (!zohoOk) console.error('zoho upsert failed', zohoResult.reason);

  res.status(neonOk || zohoOk ? 200 : 500).json({
    ok: neonOk || zohoOk,
    submissionId,
    zohoLeadId,
    zohoAction,
    neon: neonOk,
    zoho: zohoOk,
  });
}
