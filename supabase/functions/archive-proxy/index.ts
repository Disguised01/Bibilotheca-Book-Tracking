// Internet Archive's /download/ endpoint redirects to a specific storage
// node (e.g. ia601409.us.archive.org) to actually serve the file bytes.
// archive.org itself is generally CORS-friendly, but these storage nodes
// are inconsistent about sending Access-Control-Allow-Origin, so some
// files fail with a browser-side CORS error even though nothing is
// actually wrong with the file or the id link. This proxy fetches
// server-side (where CORS doesn't apply) and re-serves with the right
// headers attached — same fix already used for gutenberg-proxy.

// Accept archive.org itself and any of its storage-node subdomains
// (ia<digits>.us.archive.org and similar patterns Archive uses).
function isAllowedHost(hostname: string): boolean {
  return hostname === 'archive.org' || hostname === 'www.archive.org' || hostname.endsWith('.archive.org');
}

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
  if (target.protocol !== 'https:' || !isAllowedHost(target.hostname)) {
    return new Response('Only HTTPS archive.org URLs are allowed', { status: 403, headers });
  }

  const upstream = await fetch(target, { redirect: 'follow' });
  if (!upstream.ok) {
    return new Response(`Archive.org returned ${upstream.status}`, {
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
