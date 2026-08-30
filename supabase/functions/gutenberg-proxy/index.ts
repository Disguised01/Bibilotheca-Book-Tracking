const ALLOWED_HOSTS = new Set(['www.gutenberg.org', 'gutenberg.org']);

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

Deno.serve(async request => {
  const headers = corsHeaders();
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers });
  }

  const rawUrl = new URL(request.url).searchParams.get('url');
  if (!rawUrl) return new Response('Missing url', { status: 400, headers });

  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    return new Response('Invalid url', { status: 400, headers });
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return new Response('Only HTTPS Gutenberg URLs are allowed', { status: 403, headers });
  }

  const upstream = await fetch(target, { redirect: 'follow' });
  if (!upstream.ok) {
    return new Response(`Gutenberg returned ${upstream.status}`, {
      status: upstream.status,
      headers,
    });
  }

  const responseHeaders = {
    ...headers,
    'Content-Type': upstream.headers.get('Content-Type') || 'application/octet-stream',
    'Cache-Control': 'public, max-age=3600',
  };
  return new Response(upstream.body, { status: 200, headers: responseHeaders });
});
