/** Server-side fetch helper for SSR/ISR pages (public endpoints only). */
const SERVER_API_URL = process.env.GATEWAY_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function serverApi<T = any>(path: string, revalidateSeconds = 60): Promise<T | null> {
  try {
    const res = await fetch(`${SERVER_API_URL}/api/v1${path}`, {
      next: { revalidate: revalidateSeconds },
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000';
