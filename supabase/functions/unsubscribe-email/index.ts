import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifyUnsubscribeToken } from '../_shared/email/unsubscribeToken.ts';
import { markUserUnsubscribed } from '../_shared/email/dataAccess.ts';

function htmlResponse(status: number, title: string, message: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>` +
      `<body style="font-family:Georgia,serif;max-width:600px;margin:64px auto;padding:0 24px;color:#2E3B36">` +
      `<h1>${title}</h1><p>${message}</p></body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

Deno.serve(async request => {
  if (request.method !== 'GET') {
    return htmlResponse(405, 'Method not allowed', 'Please use the unsubscribe link from your email.');
  }

  const token = new URL(request.url).searchParams.get('token');
  const secret = Deno.env.get('EMAIL_UNSUBSCRIBE_SECRET') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!token || !secret || !supabaseUrl || !serviceRoleKey) {
    return htmlResponse(400, 'Invalid unsubscribe link', 'This unsubscribe link is missing or invalid.');
  }

  const userId = await verifyUnsubscribeToken(token, secret);
  if (!userId) {
    return htmlResponse(400, 'Invalid unsubscribe link', 'This unsubscribe link has expired or is invalid.');
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    await markUserUnsubscribed(supabase, userId);
  } catch (error) {
    console.error(
      'unsubscribe-email: preference update failed',
      error instanceof Error ? error.message : String(error),
    );
    return htmlResponse(500, 'Unable to update preferences', 'Please try again later.');
  }

  return htmlResponse(200, 'You are unsubscribed', 'You will no longer receive Japam campaign emails.');
});
