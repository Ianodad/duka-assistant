import 'server-only';
import { cookies } from 'next/headers';
import { SID_COOKIE, validSid } from '@/lib/shop/session';

/** Session id for server components (read only; the cart API sets the cookie). */
export async function requestSid(): Promise<string | undefined> {
  return validSid((await cookies()).get(SID_COOKIE)?.value);
}
