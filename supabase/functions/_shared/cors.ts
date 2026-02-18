const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

export function getCorsOrigin(req?: Request): string {
  if (allowedOrigins.length === 0) return '*';
  const origin = req?.headers.get('Origin') || '';
  return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
}

export const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigins.length > 0 ? allowedOrigins[0] : "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
