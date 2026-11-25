import {
  LatexCompletionIndex,
  type IndexUpdate,
} from "./latex-completion-index";
const index = new LatexCompletionIndex();
self.onmessage = (event: MessageEvent<IndexUpdate>) => {
  self.postMessage(index.update(event.data));
};
