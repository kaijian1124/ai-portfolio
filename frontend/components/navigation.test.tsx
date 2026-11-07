// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
vi.mock("next/navigation", () => ({
  usePathname: () => "/projects/test-project",
}));
import { PublicHeader } from "./public-header";
import { AdminNav } from "./admin-nav";
afterEach(cleanup);
it("announces current section and supports opening and closing navigation", () => {
  render(<PublicHeader />);
  expect(
    screen
      .getByRole("link", { name: /^Projects$/ })
      .getAttribute("aria-current"),
  ).toBe("page");
  const button = screen.getByRole("button", { name: "Open navigation" });
  fireEvent.click(button);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(screen.getByRole("navigation"), { key: "Escape" });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("link", { name: /^About$/ }));
  expect(button.getAttribute("aria-expanded")).toBe("false");
});
it("keeps all admin destinations available in grouped navigation", () => {
  render(<AdminNav />);
  expect(
    screen.getByRole("navigation", { name: "Administration" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("link", { name: /^Resume$/ }).getAttribute("href"),
  ).toBe("/admin/resume");
  expect(screen.getByRole("link", { name: /^AI monitoring$/ })).toBeTruthy();
});
