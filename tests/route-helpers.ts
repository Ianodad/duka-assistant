import { NextRequest } from 'next/server';

export function jreq(path: string, body: unknown, opts: { sid?: string; origin?: string; contentType?: string } = {}) {
  const headers = new Headers({ host: 'localhost:3200', 'content-type': opts.contentType ?? 'application/json' });
  if (opts.sid) headers.set('cookie', `duka_sid=${opts.sid}`);
  if (opts.origin) headers.set('origin', opts.origin);
  return new NextRequest(`http://localhost:3200${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}
