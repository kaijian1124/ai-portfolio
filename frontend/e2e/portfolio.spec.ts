import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.route("**/health/ready", (route) =>
    route.fulfill({
      json: { status: "ready", checks: { api: "ok" } },
      headers: { "Access-Control-Allow-Origin": "*" },
    }),
  );
});
test("public navigation and responsive bounds", async ({ page }) => {
  await page.goto("/");
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
  await page
    .getByRole("navigation")
    .getByRole("link", { name: "Projects", exact: true })
    .click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.locator("h1")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
test("admin routes require a login", async ({ page }) => {
  await page.goto("/admin/projects");
  await expect(page).toHaveURL(/\/login$/);
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true }),
  ).toBeVisible();
});
test("validated SSE answer and feedback interface", async ({ page }) => {
  await page.route("**/api/chat", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: 'event: answer\ndata: {"text":"TEST ONLY browser fixture","sources":[{"id":"test","title":"TEST source","url":"/about","excerpt":"TEST evidence"}],"message_id":"11111111-1111-4111-8111-111111111111"}\n\nevent: done\ndata: {}\n\n',
    }),
  );
  await page.route("**/api/chat/feedback", (route) =>
    route.fulfill({ json: { saved: true } }),
  );
  await page.goto("/chat");
  await expect(page.getByLabel("Your question")).toBeEnabled({
    timeout: 15000,
  });
  await page.getByLabel("Your question").fill("What skills are published?");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("TEST ONLY browser fixture")).toBeVisible();
  await page.getByText("Sources (1)").click();
  await expect(page.getByRole("link", { name: "TEST source" })).toBeVisible();
  await page.getByRole("button", { name: "Helpful", exact: true }).click();
  await expect(page.getByText("Thanks for your feedback.")).toBeVisible();
});
