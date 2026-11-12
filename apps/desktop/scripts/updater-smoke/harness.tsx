import { createRoot } from "react-dom/client";
import "../../src/styles/globals.css";
import {
  UpdateIndicator,
  UpdateSettings,
  UpdateDialog,
} from "../../src/components/app-updates";
import { useUpdateStore } from "../../src/stores/update-store";
import { updates } from "../../src/lib/backend/updates";
const status = {
  runningVersion: "1.7.0",
  installation: "appimage" as const,
  availableVersion: "1.8.0",
  installedVersion: null,
  notes:
    "A new codex-prism release is available.\n\nImproved writing and PDF review.",
  releaseUrl: "https://github.com/beniz/codex-prism/releases/tag/v1.8.0",
  canInstall: true,
  ready: false,
};
updates.local = async () => ({ ...status });
updates.check = async () => ({ ...status });
useUpdateStore.setState({ status, phase: "idle", open: false });
if (new URLSearchParams(location.search).has("dark"))
  document.documentElement.classList.add("dark");
createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background p-12 text-foreground">
    <div className="max-w-md space-y-8">
      <h1 className="font-semibold text-xl">Application updates</h1>
      <UpdateSettings />
      <footer className="flex items-center gap-2 rounded border p-3 text-sm">
        codex-prism v1.7.0 <UpdateIndicator />
      </footer>
    </div>
    <UpdateDialog />
  </main>,
);
const wait = () => new Promise((r) => setTimeout(r, 100));
(window as any).runSmoke = async () => {
  await wait();
  const button = document.querySelector<HTMLButtonElement>(
    '[aria-label="Update available: v1.8.0"]',
  );
  if (!button?.querySelector("svg")) throw new Error("Missing update icon");
  button.click();
  await wait();
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog?.textContent?.includes("Download update"))
    throw new Error("Missing download action");
  useUpdateStore.setState({ status: { ...status, ready: true } });
  await wait();
  if (!dialog.textContent?.includes("Restart and update"))
    throw new Error("Missing install action");
  useUpdateStore.setState({
    status: {
      ...status,
      installation: "deb",
      canInstall: false,
      installedVersion: "1.8.0",
    },
  });
  await wait();
  if (!dialog.textContent?.includes("Restart to use v1.8.0"))
    throw new Error("Missing local restart action");
  useUpdateStore.setState({
    status: { ...status, installation: "source", canInstall: false },
  });
  await wait();
  if (
    dialog.textContent?.includes("Download update") ||
    !dialog.textContent?.includes("Source update instructions")
  )
    throw new Error("Wrong source-build action");
  useUpdateStore.setState({ status });
  await wait();
  return {
    ok: true,
    steps:
      "indicator → download → restart → Debian installed version → source instructions",
  };
};
