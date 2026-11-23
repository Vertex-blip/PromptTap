import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyTelegramData(raw, token, now = Date.now()) {
  if (!raw || !token || raw.length > 16384) return null;
  const params = new URLSearchParams(raw);
  if (new Set(params.keys()).size !== [...params.keys()].length) return null;
  const hash = params.get('hash');
  const date = Number(params.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash) || !Number.isFinite(date) || date * 1000 > now + 30000 || now - date * 1000 > 3600000) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) return null;
  try {
    const user = JSON.parse(params.get('user'));
    return Number.isSafeInteger(user?.id) && user.id > 0 ? user : null;
  } catch { return null; }
}
