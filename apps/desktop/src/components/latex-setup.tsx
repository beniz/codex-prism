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
  const alternatives =
    status?.engines.filter((engine) => engine !== "pdflatex") ?? [];
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium text-sm">LaTeX</p>
          <p className="text-muted-foreground text-xs" role="status">
            {checking
              ? "Checking..."
              : error
                ? "Could not check LaTeX installation"
                : missing
                  ? alternatives.length > 0
                    ? `Available: ${alternatives.join(", ")}. Default pdfLaTeX is unavailable.`
                    : "No usable LaTeX compiler detected"
                  : `Available: ${status?.engines.join(", ") ?? "pdflatex"}`}
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
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
      {!checking && !error && missing && (
        <div className="space-y-2 text-muted-foreground text-sm">
          {alternatives.length > 0 ? (
            <p>
              Documents use pdfLaTeX by default. Add
              {` % !TEX program = ${alternatives[0]} `}
              within your main document's first 20 lines, or install pdfLaTeX in
              your existing TeX distribution. Bibliography documents also need
              BibTeX or Biber in that installation.
            </p>
          ) : navigator.userAgent.includes("Windows") ? (
            <p>
              Rerun the Windows setup to install MiKTeX, or repair your existing
              MiKTeX/TeX Live installation and add its bin directory to PATH.
              Then click Refresh.
            </p>
          ) : navigator.userAgent.includes("Mac") ? (
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
