import { useId, useState } from "react";
import { CheckIcon, Loader2Icon, SquareIcon } from "lucide-react";
import type { AgentEvent } from "@/lib/backend";
import { useAgentChatStore } from "@/stores/agent-chat-store";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ActivityLabel } from "./activity-label";

type Question = {
  id: string;
  question: string;
  options?: { label: string; description?: string }[];
};
type Answer = { option: number | null; text: string };

/** Keep this mounted while switching chats so unfinished answers are retained. */
export function QuestionRequest({
  event,
  planning,
  onStop,
}: {
  event: AgentEvent;
  planning: boolean;
  onStop?: () => void;
}) {
  const respond = useAgentChatStore((s) => s.respond);
  const id = useId();
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const questions: Question[] = event.params.questions ?? [];
  const answered = questions.filter((q) => answers[q.id]?.text.trim()).length;
  const choose = (question: string, answer: Answer) =>
    setAnswers((old) => ({ ...old, [question]: answer }));
  const choiceClass = (selected: boolean) =>
    cn(
      "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2 text-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1",
      selected
        ? "border-violet-400 bg-violet-50 dark:border-violet-500 dark:bg-violet-950"
        : "border-border hover:bg-muted/70",
    );
  return (
    <form
      aria-label={planning ? "Plan questions" : "Codex questions"}
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (submitting || !questions.length || answered !== questions.length)
          return;
        setSubmitting(true);
        setError(null);
        void respond(event, {
          answers: Object.fromEntries(
            questions.map((q) => [q.id, { answers: [answers[q.id].text] }]),
          ),
        })
          .catch((error) => setError(String(error)))
          .finally(() => setSubmitting(false));
      }}
    >
      <div className="flex items-center justify-between gap-2 px-1">
        <ActivityLabel
          kind={planning ? "plan" : "approval"}
          label={planning ? "Plan questions" : "Your input is needed"}
        />
        <span role="status" className="text-muted-foreground text-xs">
          {answered} of {questions.length} answered
        </span>
      </div>
      <div className="max-h-72 space-y-4 overflow-y-auto px-1 py-1">
        {questions.map((q, index) => {
          const answer = answers[q.id];
          const name = `${id}-${q.id}`;
          const custom = answer?.option === null || !q.options?.length;
          return (
            <fieldset
              key={q.id}
              disabled={submitting}
              className="min-w-0 space-y-2 disabled:opacity-60"
            >
              <legend className="mb-2 font-medium text-sm">
                {questions.length > 1 && `${index + 1}. `}
                {q.question}
              </legend>
              {q.options?.map((option, optionIndex) => {
                const selected = answer?.option === optionIndex;
                return (
                  <label
                    key={optionIndex}
                    className={choiceClass(selected)}
                    data-selected={selected}
                  >
                    <input
                      type="radio"
                      name={name}
                      value={option.label}
                      checked={selected}
                      onChange={() =>
                        choose(q.id, {
                          option: optionIndex,
                          text: option.label,
                        })
                      }
                      className="mt-0.5 shrink-0 accent-violet-600 dark:accent-violet-400"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block break-words font-medium",
                          selected && "text-[var(--syntax-special)]",
                        )}
                      >
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block text-muted-foreground text-xs">
                          {option.description}
                        </span>
                      )}
                    </span>
                    {selected && (
                      <span className="flex shrink-0 items-center gap-1 text-[var(--syntax-special)] text-xs">
                        <CheckIcon aria-hidden="true" className="size-3.5" />
                        Selected
                      </span>
                    )}
                  </label>
                );
              })}
              {!!q.options?.length && (
                <label className={choiceClass(custom)} data-selected={custom}>
                  <input
                    type="radio"
                    name={name}
                    value="custom"
                    checked={custom}
                    onChange={() => choose(q.id, { option: null, text: "" })}
                    className="mt-0.5 shrink-0 accent-violet-600 dark:accent-violet-400"
                  />
                  <span className="flex-1">Write your own answer</span>
                  {custom && (
                    <CheckIcon
                      aria-label="Selected"
                      className="size-3.5 text-[var(--syntax-special)]"
                    />
                  )}
                </label>
              )}
              {custom && (
                <textarea
                  aria-label={`Your answer: ${q.question}`}
                  rows={2}
                  className="block w-full resize-y rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  placeholder="Type your answer…"
                  value={answer?.text ?? ""}
                  onChange={(e) =>
                    choose(q.id, { option: null, text: e.target.value })
                  }
                />
              )}
            </fieldset>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      <div className="flex items-center justify-between gap-2 border-t pt-2">
        {onStop ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={submitting}
            onClick={onStop}
          >
            <SquareIcon className="size-3" />
            Stop
          </Button>
        ) : (
          <span />
        )}
        <Button
          type="submit"
          size="sm"
          disabled={
            submitting || !questions.length || answered !== questions.length
          }
        >
          {submitting ? (
            <>
              <Loader2Icon className="size-3.5 animate-spin" />
              Sending answers…
            </>
          ) : (
            "Submit answers"
          )}
        </Button>
      </div>
    </form>
  );
}
