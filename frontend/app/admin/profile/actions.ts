"use server";

import { revalidatePath } from "next/cache";
import { getAdminAccess } from "../../../lib/admin-session";
import { saveAdminProfile } from "../../../lib/admin-profile";
import {
  profileFieldNames,
  profileSaveSchema,
  type ProfileFormState,
} from "../../../lib/profile-schema";

export async function saveProfileAction(
  _previous: ProfileFormState,
  form: FormData,
): Promise<ProfileFormState> {
  const access = await getAdminAccess();
  if (access.state !== "authorized") {
    return {
      status: access.state === "unavailable" ? "unavailable" : "denied",
      message:
        "We could not verify administrator access. Sign in again or retry.",
    };
  }
  const revision = form.get("expected_revision");
  const parsed = profileSaveSchema.safeParse({
    profile: Object.fromEntries(
      profileFieldNames.map((name) => [name, form.get(name)]),
    ),
    expected_revision:
      typeof revision === "string"
        ? revision === ""
          ? null
          : Number(revision)
        : undefined,
    request_id: form.get("request_id"),
  });
  if (!parsed.success)
    return {
      status: "invalid",
      message: "Check required fields, lengths, email, and HTTPS links.",
    };
  const result = await saveAdminProfile(access.accessToken, parsed.data);
  if (result.status === "error") {
    const messages = {
      denied: "Administrator access was denied. Sign in again before saving.",
      conflict:
        "A newer version exists or this request ID was reused. Reload the latest profile before editing.",
      invalid: "Check required fields, lengths, email, and HTTPS links.",
      unavailable:
        "Save outcome unconfirmed. Retry the same save, or reload the latest profile before making changes.",
    };
    return { status: result.reason, message: messages[result.reason] };
  }
  revalidatePath("/");
  return {
    status: "saved",
    message: "Profile saved.",
    profile: result.profile,
  };
}
