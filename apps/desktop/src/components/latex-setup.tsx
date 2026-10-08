import { useCallback, useEffect, useState } from "react";
import { detectTexlive, type TexliveStatus } from "@/lib/latex-compiler";
import { Button } from "@/components/ui/button";

export function LatexSetup() {
  const [status, setStatus] = useState<TexliveStatus | null>(null);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setStatus(await detectTexlive());
    } catch (error) {
      setError(String(error));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const missing = status !== null && !status.engines.includes("pdflatex");
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">LaTeX (pdflatex)</p>
          <p className="text-xs text-muted-foreground" role="status">
            {checking
              ? "Checking..."
              : error
                ? "Could not check LaTeX installation"
                : missing
                  ? "pdflatex not detected"
                  : "Installed"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={checking}
          onClick={() => void check()}
        >
          Refresh
        </Button>
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
      {!checking && !error && missing && (
        <div className="space-y-2 text-sm text-muted-foreground">
          {navigator.userAgent.includes("Mac") ? (
            <>
              <p>Install MacTeX using Homebrew in Terminal:</p>
              <code className="block select-text overflow-x-auto rounded bg-muted p-2 text-xs">
                brew install --cask mactex-no-gui
              </code>
              <p>After installation, click Refresh to detect pdflatex.</p>
            </>
          ) : (
            <p>
              Install TeX Live with pdflatex and add its bin directory to PATH,
              then click Refresh.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
