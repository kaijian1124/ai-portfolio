import "server-only";

export async function checkBackendAdmin(
  token: string,
  userId: string,
): Promise<"verified" | "denied" | "unavailable"> {
  try {
    const url = new URL(process.env.NEXT_PUBLIC_API_BASE_URL ?? "");
    const localHttp =
      process.env.NODE_ENV !== "production" &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname);
    if (
      (!localHttp && url.protocol !== "https:") ||
      url.username ||
      url.password
    )
      return "unavailable";
    const response = await fetch(new URL("/api/v1/admin/me", url), {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401 || response.status === 403) return "denied";
    if (!response.ok) return "unavailable";
    const data = await response.json();
    return data?.role === "admin" && data?.user_id === userId
      ? "verified"
      : "denied";
  } catch {
    return "unavailable";
  }
}
