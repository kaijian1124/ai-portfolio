// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { ChatPanel } from "./chat-panel";
vi.mock("../lib/backend-readiness", () => ({
  warmBackend: vi.fn().mockResolvedValue(true),
}));
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_API_BASE_URL", "http://localhost:8000");
  Element.prototype.scrollIntoView = vi.fn().mockReturnValue(Promise.resolve());
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("renders after promise-returning scroll and handles validated answer and feedback", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockImplementation(async (url: string) =>
        url === "/api/chat"
          ? new Response(
              'event: answer\ndata: {"text":"TEST verified answer","sources":[{"id":"test","url":"/about","title":"TEST source","excerpt":"TEST evidence"}],"message_id":"11111111-1111-4111-8111-111111111111"}\n\nevent: done\ndata: {}\n\n',
            )
          : new Response('{"saved":true}'),
      ),
  );
  render(<ChatPanel />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Your question") as HTMLTextAreaElement).disabled,
    ).toBe(false),
  );
  fireEvent.change(screen.getByLabelText("Your question"), {
    target: { value: "What skills?" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send ↗" }));
  expect(await screen.findByText("TEST verified answer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Helpful$/ }));
  expect(await screen.findByText("Thanks for your feedback.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "New conversation" }));
  expect(await screen.findByText("New conversation started.")).toBeTruthy();
});
