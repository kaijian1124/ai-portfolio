import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminAccess } from "../../../../../lib/admin-session";
import { backendFetch } from "../../../../../lib/backend";
import { boundedJson } from "../../../../../lib/request-body";
export const runtime = "nodejs";
export const maxDuration = 60;
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("analyze"), request_id: z.uuid() }).strict(),
  z
    .object({
      action: z.literal("apply"),
      request_id: z.uuid(),
      candidate_ids: z.array(z.uuid()).min(1).max(50),
    })
    .strict(),
]);
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const access = await getAdminAccess();
  if (access.state !== "authorized")
    return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  const { id } = await params;
  if (!z.uuid().safeParse(id).success)
    return NextResponse.json({ error: "Invalid Resume." }, { status: 422 });
  try {
    const parsed = input.safeParse(await boundedJson(request));
    if (!parsed.success)
      return NextResponse.json(
        { error: "Invalid selection." },
        { status: 422 },
      );
    const body = parsed.data;
    const path = `/api/v1/admin/resumes/${id}/imports${body.action === "apply" ? `/${body.request_id}/apply` : ""}`;
    const response = await backendFetch(path, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        body.action === "apply"
          ? { candidate_ids: body.candidate_ids }
          : { request_id: body.request_id },
      ),
    });
    if (!response.ok)
      return NextResponse.json(
        {
          error:
            response.status === 429
              ? "AI budget or rate limit reached."
              : "Analysis unavailable. Check AI keys, budget and migration.",
        },
        { status: response.status },
      );
    return NextResponse.json(await response.json(), {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "Outcome unconfirmed. Retry the same request before starting another analysis.",
      },
      { status: 503 },
    );
  }
}
