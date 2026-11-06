import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { backendFetch } from "../../../lib/backend";
import { boundedJson } from "../../../lib/request-body";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const secret = process.env.CHAT_PROXY_SECRET;
  if (!secret || secret.length < 32)
    return NextResponse.json(
      { error: "The assistant is temporarily unavailable." },
      { status: 503 },
    );
  try {
    const parsed = z
      .object({ question: z.string().trim().min(1).max(2000) })
      .strict()
      .safeParse(await boundedJson(request));
    if (!parsed.success)
      return NextResponse.json(
        { error: "Ask a question up to 2,000 characters." },
        { status: 422 },
      );
    const session = request.cookies.get("portfolio_chat")?.value;
    const ip =
      request.headers.get("x-vercel-forwarded-for") ??
      (process.env.NODE_ENV !== "production"
        ? request.headers.get("x-forwarded-for")
        : null) ??
      "unknown";
    const response = await backendFetch("/api/v1/chat", {
      method: "POST",
      signal: request.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Portfolio-Proxy": secret,
        "X-Portfolio-Client-IP": ip.split(",")[0].trim(),
        ...(session ? { Cookie: `portfolio_chat=${session}` } : {}),
      },
      body: JSON.stringify(parsed.data),
    });
    if (!response.ok)
      return NextResponse.json(
        {
          error:
            response.status === 429
              ? "The assistant has reached its usage limit. Please try later."
              : "The assistant is temporarily unavailable.",
        },
        { status: response.status },
      );
    const headers = new Headers({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) headers.set("set-cookie", cookie);
    return new Response(response.body, { status: 200, headers });
  } catch {
    return NextResponse.json(
      { error: "The assistant could not complete the request." },
      { status: 503 },
    );
  }
}
