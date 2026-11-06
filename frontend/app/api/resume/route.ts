import { NextResponse } from "next/server";
import { publicRows, text } from "../../../lib/public-data";
export const dynamic = "force-dynamic";
export async function GET() {
  const result = await publicRows("resumes", { limit: 1 });
  if (!result.ok)
    return new NextResponse("Resume temporarily unavailable", { status: 503 });
  const resume = result.rows[0];
  if (!resume) return new NextResponse("No active Resume", { status: 404 });
  const key = process.env.SUPABASE_SECRET_KEY,
    base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const path = text(resume, "storage_path");
  if (
    !key ||
    !base ||
    !/^sb_secret_|^eyJ/.test(key) ||
    !/^[a-f0-9-]+\/[a-f0-9-]+\.pdf$/.test(path)
  )
    return new NextResponse("Resume download is not configured", {
      status: 503,
    });
  try {
    const response = await fetch(
      base + "/storage/v1/object/sign/portfolio-resumes/" + path,
      {
        method: "POST",
        headers: {
          apikey: key,
          "Content-Type": "application/json",
          ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({ expiresIn: 60 }),
        cache: "no-store",
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok) throw new Error();
    const { signedURL } = await response.json();
    const url = signedURL.startsWith("https://")
      ? signedURL
      : base +
        (signedURL.startsWith("/storage/v1/")
          ? signedURL
          : "/storage/v1/" + signedURL.replace(/^\//, ""));
    if (new URL(url).origin !== new URL(base).origin) throw new Error();
    const redirect = NextResponse.redirect(url);
    redirect.headers.set("Cache-Control", "no-store");
    return redirect;
  } catch {
    return new NextResponse("Resume download temporarily unavailable", {
      status: 503,
    });
  }
}
