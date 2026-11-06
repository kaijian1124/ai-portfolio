import { NextRequest, NextResponse } from "next/server";
import { getAdminAccess } from "../../../../lib/admin-session";
import { backendFetch } from "../../../../lib/backend";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  if (request.headers.get("origin") !== request.nextUrl.origin)
    return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
  const access = await getAdminAccess();
  if (access.state !== "authorized")
    return NextResponse.json({ error: "Sign in again" }, { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 4259840)
    return NextResponse.json({ error: "File too large" }, { status: 413 });
  try {
    const reader = request.body?.getReader();
    if (!reader)
      return NextResponse.json({ error: "File required" }, { status: 422 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4259840) {
        await reader.cancel();
        return NextResponse.json({ error: "File too large" }, { status: 413 });
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const form = await new Response(bytes, {
      headers: { "Content-Type": request.headers.get("content-type") ?? "" },
    }).formData();
    for (const field of ["project_id", "replace_id"])
      if (form.get(field) === "") form.delete(field);
    const response = await backendFetch("/api/v1/admin/uploads", {
      method: "POST",
      headers: { Authorization: `Bearer ${access.accessToken}` },
      body: form,
    });
    if (!response.ok)
      return NextResponse.json(
        { error: "Upload unavailable or invalid file" },
        { status: response.status },
      );
    return NextResponse.json(await response.json(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Upload outcome unconfirmed" },
      { status: 503 },
    );
  }
}
