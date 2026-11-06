import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminAccess } from "../../../../../../lib/admin-session";
import { backendFetch } from "../../../../../../lib/backend";
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ resource: string; id: string }> },
) {
  const { resource, id } = await params;
  if (
    !["documents", "resumes"].includes(resource) ||
    !z.uuid().safeParse(id).success
  )
    return new NextResponse("Not found", { status: 404 });
  const access = await getAdminAccess();
  if (access.state !== "authorized")
    return NextResponse.redirect(new URL("/login", request.url));
  const version = request.nextUrl.searchParams.get("version_id");
  if (version && !z.uuid().safeParse(version).success)
    return new NextResponse("Invalid version", { status: 422 });
  try {
    const response = await backendFetch(
      `/api/v1/admin/files/${resource}/${id}${version ? `?version_id=${version}` : ""}`,
      { headers: { Authorization: `Bearer ${access.accessToken}` } },
    );
    if (!response.ok)
      return new NextResponse("Download unavailable", {
        status: response.status,
      });
    const { url } = await response.json();
    if (
      new URL(url).origin !==
      new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin
    )
      throw new Error();
    const result = NextResponse.redirect(url);
    result.headers.set("Cache-Control", "private, no-store");
    return result;
  } catch {
    return new NextResponse("Download unavailable", { status: 503 });
  }
}
