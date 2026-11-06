import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { backendFetch } from "../../../../lib/backend";
import { boundedJson } from "../../../../lib/request-body";
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const secret = process.env.CHAT_PROXY_SECRET,
    session = request.cookies.get("portfolio_chat")?.value;
  if (!secret || !session)
    return NextResponse.json({ error: "Session unavailable" }, { status: 403 });
  try {
    const data = z
      .object({
        message_id: z.uuid(),
        vote: z.union([z.literal(1), z.literal(-1)]),
      })
      .strict()
      .parse(await boundedJson(request, 2048));
    const response = await backendFetch("/api/v1/chat/feedback", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Portfolio-Proxy": secret,
        Cookie: `portfolio_chat=${session}`,
      },
      body: JSON.stringify(data),
    });
    return NextResponse.json(
      { saved: response.ok },
      { status: response.status },
    );
  } catch {
    return NextResponse.json({ saved: false }, { status: 503 });
  }
}
