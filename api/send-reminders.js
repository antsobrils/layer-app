// api/send-reminders.js
// Runs every hour via Vercel Cron
// Checks which athletes have a reminder due in this hour and sends them an email

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RESEND_KEY   = process.env.RESEND_API_KEY;
const APP_URL      = process.env.APP_URL || 'https://layer-app-antsobrils-4227s-projects.vercel.app';

export default async function handler(req, res) {
  // Only allow cron or manual GET requests
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const now = new Date();
    const currentHour = now.getUTCHours();
    const currentMinute = now.getUTCMinutes();

    // Fetch all athletes with reminders enabled
    const athRes = await fetch(
      `${SUPABASE_URL}/rest/v1/athletes?reminder_enabled=eq.true&select=id,name,email,phone,coach_id,reminder_time`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const athletes = await athRes.json();

    if (!athletes || athletes.length === 0) {
      return res.status(200).json({ sent: 0, message: 'No athletes with reminders enabled' });
    }

    // Filter athletes whose reminder_time matches the current hour
    // reminder_time is stored as "HH:MM:SS" in UTC
    const due = athletes.filter(a => {
      if (!a.reminder_time) return false;
      const [h, m] = a.reminder_time.split(':').map(Number);
      return h === currentHour && m < 60; // match on hour
    });

    if (due.length === 0) {
      return res.status(200).json({ sent: 0, message: `No reminders due at hour ${currentHour}` });
    }

    // Check who has already checked in today
    const today = now.toISOString().split('T')[0];
    const ids = due.map(a => a.id);
    const checkinRes = await fetch(
      `${SUPABASE_URL}/rest/v1/checkin_responses?date=eq.${today}&athlete_id=in.(${ids.join(',')})&select=athlete_id`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const checkedIn = await checkinRes.json();
    const checkedInIds = new Set((checkedIn || []).map(r => r.athlete_id));

    // Only send to athletes who haven't checked in yet
    const toSend = due.filter(a => !checkedInIds.has(a.id));

    if (toSend.length === 0) {
      return res.status(200).json({ sent: 0, message: 'All due athletes have already checked in today' });
    }

    // Send emails via Resend
    const results = await Promise.allSettled(toSend.map(athlete => sendEmail(athlete)));
    const sent    = results.filter(r => r.status === 'fulfilled').length;
    const failed  = results.filter(r => r.status === 'rejected').length;

    return res.status(200).json({ sent, failed, total: toSend.length });

  } catch (err) {
    console.error('Reminder error:', err);
    return res.status(500).json({ error: err.message });
  }
}

async function sendEmail(athlete) {
  const checkinUrl = `${APP_URL}/checkin_form.html?athlete=${athlete.id}`;
  const firstName  = athlete.name.split(' ')[0];

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="background:#0f0f0f;margin:0;padding:0;font-family:'DM Sans',sans-serif;">
      <div style="max-width:480px;margin:0 auto;padding:40px 24px;">

        <div style="font-family:Georgia,serif;font-size:24px;color:#1D9E75;margin-bottom:32px;">Layer.</div>

        <div style="background:#181818;border:1px solid #242424;border-radius:16px;padding:28px;">
          <p style="font-family:Georgia,serif;font-size:22px;color:#f0ede6;margin:0 0 10px;">
            Morning, ${firstName}.
          </p>
          <p style="font-size:14px;color:#707068;line-height:1.6;margin:0 0 24px;">
            Your coach is waiting on today's check-in. It takes under 60 seconds — how are you actually feeling today?
          </p>
          <a href="${checkinUrl}"
             style="display:inline-block;background:#1D9E75;color:#ffffff;text-decoration:none;border-radius:12px;padding:14px 28px;font-size:15px;font-weight:600;">
            Start today's check-in →
          </a>
        </div>

        <div style="text-align:center;margin-top:20px;">
          <a href="${APP_URL}/athlete_dashboard.html?athlete=${athlete.id}"
             style="font-size:12px;color:#444;text-decoration:none;">
            View your dashboard
          </a>
          &nbsp;·&nbsp;
          <a href="${APP_URL}/athlete_dashboard.html?athlete=${athlete.id}"
             style="font-size:12px;color:#444;text-decoration:none;">
            Manage reminders
          </a>
        </div>
      </div>
    </body>
    </html>
  `;

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Layer <reminders@layer.coach>',
      to: athlete.email,
      subject: `${firstName}, time for your daily check-in`,
      html
    })
  });

  if (!emailRes.ok) {
    const err = await emailRes.json();
    throw new Error(`Email failed for ${athlete.email}: ${JSON.stringify(err)}`);
  }

  return emailRes.json();
}
