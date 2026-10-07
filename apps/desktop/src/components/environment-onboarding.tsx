import { useEffect, useState } from "react";
import { AgentSetup } from "@/components/agent-setup";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAgentSetupStore } from "@/stores/agent-setup-store";

/** Only Codex is required for AI setup. Python and skills are optional settings. */
export function EnvironmentOnboarding() {
  const status = useAgentSetupStore((s) => s.status);
  const checkStatus = useAgentSetupStore((s) => s.checkStatus);
  const [opened, setOpened] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);
  useEffect(() => {
    if (status !== "checking" && status !== "ready") {
      setOpened(true);
      setDismissed(false);
    }
  }, [status]);
  return (
    <Dialog open={opened && !dismissed} onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Welcome to codex-prism</DialogTitle>
          <DialogDescription>
            Connect Codex for AI writing. Python and scientific skills can be
            configured later in workspace settings.
          </DialogDescription>
        </DialogHeader>
        <AgentSetup />
        <Button
          disabled={status !== "ready"}
          onClick={() => setDismissed(true)}
        >
          Done
        </Button>
      </DialogContent>
    </Dialog>
  );
}
