import {
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  FilePenLineIcon,
  FileTextIcon,
  ImageIcon,
  ListChecksIcon,
  MessageCircleIcon,
  Minimize2Icon,
  SearchIcon,
  ShieldQuestionIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react";
import type { ActivityKind, ActivityState } from "@/lib/chat-activity";

const icons = {
  command: TerminalIcon,
  read: FileTextIcon,
  image: ImageIcon,
  research: SearchIcon,
  edit: FilePenLineIcon,
  plan: ListChecksIcon,
  progress: MessageCircleIcon,
  context: Minimize2Icon,
  tool: WrenchIcon,
  approval: ShieldQuestionIcon,
  error: CircleAlertIcon,
};
export function ActivityLabel({
  kind,
  label,
}: {
  kind: ActivityKind;
  label: string;
}) {
  const Icon = icons[kind];
  return (
    <span
      data-activity-kind={kind}
      className="activity-label inline-flex max-w-full items-center gap-1.5 text-xs font-medium"
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{label}</span>
    </span>
  );
}
export function ActivityStatus({ state }: { state: ActivityState | null }) {
  if (!state) return null;
  const Icon =
    state.tone === "success"
      ? CheckIcon
      : state.tone === "error"
        ? CircleAlertIcon
        : state.tone === "waiting"
          ? ClockIcon
          : null;
  return (
    <span
      data-activity-status={state.tone}
      className="activity-status inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs"
    >
      {Icon && <Icon aria-hidden="true" className="size-3" />}
      {state.label}
    </span>
  );
}
