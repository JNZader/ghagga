const allowedOrigins = (Deno.env.get('ALLOWED_ORIGINS') || '').split(',').filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn(
    '[CORS] ALLOWED_ORIGINS is not set. CORS will reject all cross-origin requests. ' +
    'Set ALLOWED_ORIGINS to your dashboard URL (e.g., "https://your-app.github.io").'
  );
}

export function getCorsOrigin(req?: Request): string {
  if (allowedOrigins.length === 0) return '';
  const origin = req?.headers.get('Origin') || '';
  return allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
}

export function getCorsHeaders(req?: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": getCorsOrigin(req),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  };
}

// Static headers for backwards compatibility - uses first allowed origin
export const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigins.length > 0 ? allowedOrigins[0] : "",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Vary": "Origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};
