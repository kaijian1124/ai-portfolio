import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminAccess } from "../../../../../../lib/admin-session";
import { adminApi } from "../../../../../../lib/catalog";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ kind: string; id: string }> },
) {
  const { kind, id } = await params;
  const headers = { "Cache-Control": "private, no-store" };
  const access = await getAdminAccess();
  if (access.state !== "authorized")
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers },
    );
  if (!["runs", "chunks"].includes(kind) || !z.uuid().safeParse(id).success)
    return NextResponse.json({ error: "Not found" }, { status: 404, headers });
  const result = await adminApi(
    `/api/v1/admin/retrieval-${kind}/${id}`,
    access.accessToken,
  );
  if (!result.ok || !result.data)
    return NextResponse.json(
      { error: "Unavailable" },
      { status: 404, headers },
    );
  return NextResponse.json(result.data, { headers });
}
