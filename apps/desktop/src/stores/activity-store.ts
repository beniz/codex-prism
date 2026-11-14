import { create } from "zustand";

export const activityLabels = {
  preparing: "Preparing prompt…",
  starting: "Starting Codex…",
  steering: "Sending guidance…",
  working: "Codex is working…",
  command: "Running a command…",
  edit: "Editing files…",
  research: "Searching the web…",
  read: "Reading files…",
  image: "Viewing an image…",
  tool: "Using a tool…",
  stopping: "Stopping Codex…",
  reviewing: "Preparing changes for review…",
  apply: "Applying changes…",
  saveReview: "Saving review…",
  discard: "Discarding changes…",
  repair: "Preparing conflict repair…",
  refreshing: "Refreshing document…",
  updatingPdf: "Updating PDF…",
  preparingPdf: "Preparing PDF…",
  restoring: "Restoring conversations…",
  history: "Loading history…",
  conversation: "Loading conversation…",
  syncing: "Synchronizing…",
} as const;
export type ActivityKind = keyof typeof activityLabels;
export interface ActivityOwner {
  projectPath: string | null;
  chatId?: string;
  proposalId?: string;
  generation?: number;
}
export interface Activity extends ActivityOwner {
  id: number;
  kind: ActivityKind;
  group: "operation" | "agent" | "build";
  projectWide: boolean;
}
export const useActivityStore = create<{ operations: Activity[] }>(() => ({
  operations: [],
}));
let nextId = 0;
export function beginActivity(
  owner: ActivityOwner,
  kind: ActivityKind,
  options: { group?: Activity["group"]; projectWide?: boolean } = {},
) {
  const id = ++nextId;
  useActivityStore.setState((s) => ({
    operations: [
      ...s.operations,
      {
        ...owner,
        id,
        kind,
        group: options.group ?? "operation",
        projectWide: options.projectWide ?? false,
      },
    ],
  }));
  return {
    id,
    update(kind: ActivityKind) {
      useActivityStore.setState((s) => {
        const entry = s.operations.find((o) => o.id === id);
        return !entry || entry.kind === kind
          ? s
          : {
              operations: s.operations.map((o) =>
                o.id === id ? { ...o, kind } : o,
              ),
            };
      });
    },
    finish() {
      useActivityStore.setState((s) =>
        s.operations.some((o) => o.id === id)
          ? { operations: s.operations.filter((o) => o.id !== id) }
          : s,
      );
    },
  };
}
export function proposalActivityBusy(proposalId: string) {
  return useActivityStore
    .getState()
    .operations.some(
      (o) => o.proposalId === proposalId && o.group === "operation",
    );
}
// Only current-turn lifecycle metadata, never transcript text or token deltas.
const turns = new Map<
  string,
  {
    turnId: string;
    activity: ReturnType<typeof beginActivity>;
    items: Map<string, ActivityKind>;
  }
>();
export function startActivityTurn(
  owner: ActivityOwner & { chatId: string },
  turnId: string,
) {
  const previous = turns.get(owner.chatId);
  if (previous?.turnId === turnId) return;
  previous?.activity.finish();
  turns.set(owner.chatId, {
    turnId,
    activity: beginActivity(owner, "working", { group: "agent" }),
    items: new Map(),
  });
}
export function updateActivityItem(
  chatId: string,
  turnId: string,
  item: { id: string; type: string },
  started: boolean,
) {
  const turn = turns.get(chatId);
  if (!turn || turn.turnId !== turnId) return;
  const kind: ActivityKind | undefined = (
    {
      commandExecution: "command",
      fileChange: "edit",
      fileRead: "read",
      imageView: "image",
      webSearch: "research",
      mcpToolCall: "tool",
      dynamicToolCall: "tool",
    } as Record<string, ActivityKind>
  )[item.type];
  if (started && kind) turn.items.set(item.id, kind);
  else turn.items.delete(item.id);
  const items = [...turn.items.values()];
  turn.activity.update(items[items.length - 1] ?? "working");
}
export function finishActivityTurn(chatId: string, turnId: string) {
  const turn = turns.get(chatId);
  if (turn && turn.turnId === turnId) {
    turn.activity.finish();
    turns.delete(chatId);
  }
}
export function resetActivities() {
  turns.clear();
  useActivityStore.setState((s) =>
    s.operations.length ? { operations: [] } : s,
  );
}
/** Disconnect ends agent operations; independent PDF and acceptance jobs still finish normally. */
export function disconnectActivities() {
  turns.clear();
  const agentKinds: ActivityKind[] = [
    "preparing",
    "starting",
    "steering",
    "stopping",
    "restoring",
  ];
  useActivityStore.setState((s) => {
    const operations = s.operations.filter(
      (o) => o.group !== "agent" && !agentKinds.includes(o.kind),
    );
    return operations.length === s.operations.length ? s : { operations };
  });
}
export function endStoppingActivity(chatId: string) {
  useActivityStore.setState((s) => {
    const operations = s.operations.filter(
      (o) => !(o.chatId === chatId && o.kind === "stopping"),
    );
    return operations.length === s.operations.length ? s : { operations };
  });
}
