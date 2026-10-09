import { expect, it, vi } from "vitest";
import { coalescedRefresh } from "@/lib/coalesced-refresh";
it("serializes bursts, performs a trailing pass, and recovers after errors", async () => {
  const queue = coalescedRefresh();
  let release!: () => void;
  const refresh = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    )
    .mockResolvedValue(undefined);
  const first = queue("p", refresh);
  await Promise.resolve();
  const others = Array.from({ length: 20 }, () => queue("p", refresh));
  expect(refresh).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, ...others]);
  expect(refresh).toHaveBeenCalledTimes(2);
  await expect(
    queue("p", async () => {
      throw new Error("offline");
    }),
  ).rejects.toThrow("offline");
  await queue("p", refresh);
  expect(refresh).toHaveBeenCalledTimes(3);
});
