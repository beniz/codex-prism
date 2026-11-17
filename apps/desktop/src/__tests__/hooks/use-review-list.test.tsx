import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useReviewList, type SavedReview } from "@/hooks/use-review-list";
import { collaboration } from "@/lib/collaboration";

vi.mock("@/lib/collaboration", () => ({ collaboration: vi.fn() }));

let root: Root;
let current: ReturnType<typeof useReviewList>;
const requests: Array<{
  resolve: (reviews: SavedReview[]) => void;
  reject: (error: Error) => void;
}> = [];
const review = (id: string): SavedReview => ({ id, schemaVersion: 1 });

function Probe({ project = "a", revision = "1" }) {
  current = useReviewList(project, revision);
  return null;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  requests.length = 0;
  vi.mocked(collaboration)
    .mockReset()
    .mockImplementation(
      () =>
        new Promise((resolve, reject) => requests.push({ resolve, reject })),
    );
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
});

it("ignores late results from a previous project", async () => {
  await act(async () => root.render(<Probe />));
  await act(async () => root.render(<Probe project="b" />));
  await act(async () => requests[1].resolve([review("b-review")]));
  await act(async () => requests[0].resolve([review("a-review")]));
  expect(current.reviews).toEqual([review("b-review")]);
  expect(current.loading).toBe(false);
});

it("coalesces refresh events and loads only when the review revision changes", async () => {
  await act(async () => root.render(<Probe />));
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("prism-collaboration"));
    current.refresh();
  });
  expect(requests).toHaveLength(1);
  await act(async () => requests[0].resolve([review("first")]));
  expect(requests).toHaveLength(2);
  await act(async () => requests[1].resolve([review("latest")]));
  await act(async () => root.render(<Probe />));
  expect(requests).toHaveLength(2);
  await act(async () => root.render(<Probe revision="2" />));
  expect(requests).toHaveLength(3);
  expect(current.reviews).toEqual([review("latest")]);
});

it("retains the list on refresh failure and supports retry", async () => {
  await act(async () => root.render(<Probe />));
  await act(async () => requests[0].resolve([review("saved")]));
  await act(async () => current.refresh());
  await act(async () => requests[1].reject(new Error("Unavailable")));
  expect(current.reviews).toEqual([review("saved")]);
  expect(current.error).toContain("Unavailable");
  await act(async () => current.refresh());
  await act(async () => requests[2].resolve([review("new")]));
  expect(current.error).toBeNull();
  expect(current.reviews).toEqual([review("new")]);
});
