import "server-only";
export function backendUrl(path: string) {
  if (!path.startsWith("/api/v1/")) throw new Error("Invalid API path");
  const base = new URL(process.env.NEXT_PUBLIC_API_BASE_URL ?? "");
  const local =
    process.env.NODE_ENV !== "production" &&
    base.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(base.hostname);
  if ((!local && base.protocol !== "https:") || base.username || base.password)
    throw new Error("API unavailable");
  return new URL(path, base);
}
export async function backendFetch(path: string, init: RequestInit = {}) {
  return fetch(backendUrl(path), {
    ...init,
    cache: "no-store",
    signal: AbortSignal.any([
      ...(init.signal ? [init.signal] : []),
      AbortSignal.timeout(45000),
    ]),
  });
}
