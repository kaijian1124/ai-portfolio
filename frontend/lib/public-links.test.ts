import { expect, it } from "vitest";
import { safeExternalUrl } from "./public-links";

it("allows only credential-free HTTPS links", () => {
  expect(safeExternalUrl("https://github.com/example/repo")).toBe(
    "https://github.com/example/repo",
  );
  for (const value of [
    null,
    "",
    "not a url",
    "javascript:alert(1)",
    "data:text/html,x",
    "http://example.com",
    "https://user:pass@example.com",
  ]) {
    expect(safeExternalUrl(value)).toBeNull();
  }
});
