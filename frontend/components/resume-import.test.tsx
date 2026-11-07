// @vitest-environment jsdom
import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";
import { ResumeImport } from "./resume-import";
const id = "11111111-1111-4111-8111-111111111111";
afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});
it("requires explicit selection and confirmation, then sends IDs only", async () => {
  const fetcher = vi
    .fn()
    .mockImplementation(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify(
          body.action === "analyze"
            ? {
                id,
                status: "completed",
                candidates: [
                  {
                    id,
                    resource: "skills",
                    data: { name: "Python", status: "draft" },
                    evidence_quote: "Python experience from TEST Resume",
                  },
                ],
              }
            : {
                status: "applied",
                created: [{ resource: "skills", id, title: "Python" }],
                skipped: 0,
              },
        ),
      );
    });
  vi.stubGlobal("fetch", fetcher);
  render(<ResumeImport resumeId={id} requestId={id} />);
  expect(
    await screen.findByText("Python experience from TEST Resume"),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Add selected as drafts",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByLabelText("Select skills candidate 1"));
  fireEvent.click(
    screen.getByLabelText(
      "I confirm these additions; existing content must remain unchanged.",
    ),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Add selected as drafts" }),
  );
  expect(await screen.findByText(/Added 1 draft/)).toBeTruthy();
  const sent = JSON.parse(fetcher.mock.calls[1][1].body);
  expect(sent.candidate_ids).toEqual([id]);
  expect(sent.data).toBeUndefined();
});
it("shows configuration errors without inventing or applying candidates", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          '{"error":"Analysis unavailable. Check AI keys, budget and migration."}',
          { status: 503 },
        ),
      ),
  );
  render(<ResumeImport resumeId={id} requestId={id} />);
  expect(await screen.findByText(/Analysis unavailable/)).toBeTruthy();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Add selected as drafts" }),
    ).toBeNull(),
  );
});
