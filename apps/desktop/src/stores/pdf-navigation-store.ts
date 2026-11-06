import { create } from "zustand";

export interface PdfSourceRequest {
  projectRoot: string;
  filePath: string;
  line: number;
  sourceLine: string;
  origin?: "editor";
  chatId?: string;
  sourceContent?: string;
}

// A separate request keeps PDF navigation independent of editor cursor updates.
export const usePdfNavigationStore = create<{
  request: PdfSourceRequest | null;
  navigate: (request: PdfSourceRequest) => void;
}>((set) => ({
  request: null,
  navigate: (request) => set({ request: { ...request } }),
}));
