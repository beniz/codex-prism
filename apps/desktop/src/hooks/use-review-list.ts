import { useCallback, useEffect, useRef, useState } from "react";
import { collaboration } from "@/lib/collaboration";

export interface SavedReview {
  id: string;
  scope?: string;
  reviewedCommit?: string;
  schemaVersion: number;
  proposalId?: string;
  local?: boolean;
}

/** Refresh on review transitions and external changes, never on streamed text. */
export function useReviewList(projectId: string, revision: string) {
  const [state, setState] = useState({
    projectId,
    reviews: [] as SavedReview[],
    loading: true,
    error: null as string | null,
  });
  const refreshRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    let alive = true;
    let busy = false;
    let pending = false;
    setState({ projectId, reviews: [], loading: true, error: null });
    const load = async () => {
      if (!alive) return;
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      try {
        const reviews = await collaboration<SavedReview[]>(
          projectId,
          "reviews",
        );
        if (alive)
          setState({ projectId, reviews, loading: false, error: null });
      } catch (error) {
        if (alive)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: String(error),
          }));
      } finally {
        busy = false;
        if (alive && pending) {
          pending = false;
          void load();
        }
      }
    };
    const request = () => {
      void load();
    };
    refreshRef.current = request;
    window.addEventListener("focus", request);
    window.addEventListener("prism-collaboration", request);
    return () => {
      alive = false;
      window.removeEventListener("focus", request);
      window.removeEventListener("prism-collaboration", request);
      if (refreshRef.current === request) refreshRef.current = () => {};
    };
  }, [projectId]);
  useEffect(() => {
    refresh();
  }, [projectId, revision, refresh]);
  return {
    reviews: state.projectId === projectId ? state.reviews : [],
    loading: state.projectId !== projectId || state.loading,
    error: state.projectId === projectId ? state.error : null,
    refresh,
  };
}
