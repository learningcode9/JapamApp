import type { SummaryStats } from './types';

function fmtDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function statRow(bg: string, icon: string, label: string, value: string): string {
  return `<tr style="background:${bg};">
    <td style="padding:14px 20px;font-size:15px;color:#3D2B1F;">${icon} ${label}</td>
    <td align="right" style="padding:14px 20px;font-size:20px;font-weight:bold;color:#6B4226;">${value}</td>
  </tr>`;
}

export function buildEmailHtml(stats: SummaryStats, appUrl = ''): string {
  const ctaButton = appUrl
    ? `<tr><td align="center" style="padding:28px 0 8px;">
        <a href="${appUrl}"
           style="background:#6B4226;color:#fff;text-decoration:none;padding:14px 36px;
                  border-radius:8px;font-size:16px;font-weight:bold;display:inline-block;">
          🙏 Continue Your Japam
        </a>
      </td></tr>`
    : '';

  const bestDayText = stats.bestDay
    ? `${fmtDate(stats.bestDay.date)} — ${stats.bestDay.malas} mala${stats.bestDay.malas !== 1 ? 's' : ''}`
    : '—';

  const breakdownSection = stats.breakdown
    ? `<tr><td style="padding:8px 20px 4px;color:#A0522D;font-size:13px;font-weight:bold;letter-spacing:0.05em;">
         SESSION BREAKDOWN
       </td></tr>
       <tr style="background:#FDF6EE;">
         <td style="padding:10px 20px;font-size:14px;color:#3D2B1F;">⏱️ Timer</td>
         <td align="right" style="padding:10px 20px;font-size:16px;font-weight:bold;color:#6B4226;">${stats.breakdown.timer}</td>
       </tr>
       <tr>
         <td style="padding:10px 20px;font-size:14px;color:#3D2B1F;">👆 Tap Japam</td>
         <td align="right" style="padding:10px 20px;font-size:16px;font-weight:bold;color:#6B4226;">${stats.breakdown.tap}</td>
       </tr>
       <tr style="background:#FDF6EE;">
         <td style="padding:10px 20px;font-size:14px;color:#3D2B1F;">✏️ Manual Entry</td>
         <td align="right" style="padding:10px 20px;font-size:16px;font-weight:bold;color:#6B4226;">${stats.breakdown.manual}</td>
       </tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Your 15-Day Japam Journey</title>
</head>
<body style="margin:0;padding:0;background:#FDF6EE;font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#FDF6EE;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0"
       style="max-width:600px;width:100%;background:#fff;border-radius:12px;
              overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.1);">

  <!-- Header -->
  <tr><td style="background:linear-gradient(135deg,#6B4226 0%,#A0522D 100%);
                 padding:40px 32px;text-align:center;">
    <div style="font-size:44px;margin-bottom:10px;">🕉️</div>
    <h1 style="color:#fff;margin:0;font-size:26px;font-weight:bold;letter-spacing:0.02em;">
      Your 15-Day Japam Journey
    </h1>
    <p style="color:#F5DEB3;margin:10px 0 0;font-size:14px;">
      ${fmtDate(stats.periodStart)} &nbsp;—&nbsp; ${fmtDate(stats.periodEnd)}
    </p>
  </td></tr>

  <!-- Greeting -->
  <tr><td style="padding:32px 32px 20px;">
    <p style="margin:0;font-size:18px;color:#3D2B1F;">
      Jai Shri Ram, <strong>${stats.userName}</strong> 🙏
    </p>
    <p style="color:#6B4226;font-size:15px;margin:12px 0 0;line-height:1.7;">
      Here is a gentle reflection on your devotion over the past 15 days.
      Every mala chanted, every moment of stillness, is a step toward the Divine.
    </p>
  </td></tr>

  <!-- Stats table -->
  <tr><td style="padding:0 32px;">
    <table width="100%" cellpadding="0" cellspacing="0"
           style="border-radius:8px;overflow:hidden;border:1px solid #F0E0C8;">
      ${statRow('#FDF6EE', '🪷', 'Total Sessions', stats.totalSessions.toLocaleString())}
      ${statRow('#fff',    '📿', 'Total Malas',    stats.totalMalas.toLocaleString())}
      ${statRow('#FDF6EE', '📅', 'Days Practiced', `${stats.daysPracticed} / 15`)}
      ${statRow('#fff',    '🔥', 'Longest Streak', `${stats.longestStreak} day${stats.longestStreak !== 1 ? 's' : ''}`)}
      ${statRow('#FDF6EE', '✨', 'Best Day',        bestDayText)}
      ${statRow('#fff',    '📊', 'Avg Malas / Active Day', stats.averageMalasPerActiveDay.toFixed(1))}
      ${breakdownSection}
    </table>
  </td></tr>

  <!-- Encouragement -->
  <tr><td style="padding:28px 32px 8px;">
    <div style="background:#FDF6EE;border-left:4px solid #A0522D;
                padding:18px 22px;border-radius:0 8px 8px 0;">
      <p style="margin:0;color:#6B4226;font-style:italic;line-height:1.8;font-size:15px;">
        "Nāma japa is the greatest path in Kali Yuga.
         Each mala you complete is a garland laid at the Lord's feet —
         a quiet, unbroken act of surrender.
         Keep going. Your practice matters."
      </p>
    </div>
  </td></tr>

  <!-- CTA -->
  <table width="100%" cellpadding="0" cellspacing="0">${ctaButton}</table>

  <!-- Footer -->
  <tr><td style="padding:28px 32px;text-align:center;
                 border-top:1px solid #F0E0C8;margin-top:8px;">
    <p style="margin:0;color:#A0522D;font-size:12px;line-height:1.8;">
      You are receiving this because you have an active Japam App account.<br/>
      🕉️&nbsp; <strong>Japam App</strong> &mdash; May your practice deepen every day.
    </p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;
}

export function buildEmailText(stats: SummaryStats, appUrl = ''): string {
  const bestDayText = stats.bestDay
    ? `${stats.bestDay.date}  (${stats.bestDay.malas} malas)`
    : '—';

  const breakdownText = stats.breakdown
    ? `\nSession Breakdown:\n  Timer:        ${stats.breakdown.timer}\n  Tap Japam:    ${stats.breakdown.tap}\n  Manual Entry: ${stats.breakdown.manual}`
    : '';

  const ctaText = appUrl ? `\n\nContinue your Japam: ${appUrl}` : '';

  return `🙏 Your 15-Day Japam Journey
${fmtDate(stats.periodStart)} — ${fmtDate(stats.periodEnd)}

Jai Shri Ram, ${stats.userName}!

Your 15-day Japam summary:

  🪷 Total Sessions:       ${stats.totalSessions.toLocaleString()}
  📿 Total Malas:          ${stats.totalMalas.toLocaleString()}
  📅 Days Practiced:       ${stats.daysPracticed} / 15
  🔥 Longest Streak:       ${stats.longestStreak} day${stats.longestStreak !== 1 ? 's' : ''}
  ✨ Best Day:             ${bestDayText}
  📊 Avg Malas/Active Day: ${stats.averageMalasPerActiveDay.toFixed(1)}${breakdownText}

"Nāma japa is the greatest path in Kali Yuga. Each mala you complete is a garland laid at the Lord's feet — a quiet, unbroken act of surrender. Keep going. Your practice matters."${ctaText}

🕉️ Japam App — May your practice deepen every day.`;
}
