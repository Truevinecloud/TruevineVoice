import { NextResponse, type NextRequest } from 'next/server';

type RouteContext = { params: Promise<{ path: string[] }> };
const ALLOWED = [
  /^auth\/(sign-in|sign-out)$/,
  /^platform\/operations\/(me|organizations|campaigns|health)$/,
  /^platform\/operations\/organizations\/[0-9a-f-]+\/campaigns\/[0-9a-f-]+\/emergency-stop$/i,
  /^platform\/support\/(me|organizations|users)$/,
  /^platform\/support\/organizations\/[0-9a-f-]+(\/diagnostics|\/audit)?$/i,
  /^platform\/support\/users\/[0-9a-f-]+(\/audit)?$/i,
  /^platform\/technical\/(me|overview|providers|queues|logs|audit)$/,
  /^platform\/audit\/(me|overview|organizations|audit)$/,
];

async function forward(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const targetPath = path.join('/');
  if (!ALLOWED.some((pattern) => pattern.test(targetPath))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const base = process.env['TRUEVINE_API_URL'];
  if (!base) return NextResponse.json({ error: 'api_unavailable' }, { status: 503 });

  const incoming = new URL(request.url);
  const target = new URL(`/${targetPath}`, base);
  target.search = incoming.search;
  const headers = new Headers();
  for (const name of ['content-type', 'cookie', 'x-truevine-csrf', 'user-agent']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const upstream = await fetch(target, {
    method: request.method,
    headers,
    ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}),
    cache: 'no-store',
    redirect: 'manual',
  }).catch(() => undefined);
  if (!upstream) return NextResponse.json({ error: 'api_unavailable' }, { status: 503 });

  const responseHeaders = new Headers();
  for (const name of ['content-type', 'cache-control']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  for (const cookie of upstream.headers.getSetCookie())
    responseHeaders.append('set-cookie', cookie);
  return new NextResponse(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export const GET = forward;
export const POST = forward;
