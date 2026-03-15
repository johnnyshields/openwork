import { Show, For, createSignal, createEffect } from "solid-js";
import { X, Eye, FileText, MessageSquare, Wrench } from "lucide-solid";
import type { MessageWithParts } from "../types";

export type DelegationContextData = {
  messages: Array<{ role: string; content: string }>;
  messageCount: number;
  toolCallCount: number;
};

export default function DelegationContextPanel(props: {
  open: boolean;
  onClose: () => void;
  context: DelegationContextData | null;
  watchedMessages: MessageWithParts[];
  watchRunPhase: string;
  onStartWatch: () => void;
  onStopWatch: () => void;
  isWatching: boolean;
}) {
  const [activeTab, setActiveTab] = createSignal<"context" | "watch">("context");
  let scrollRef: HTMLDivElement | undefined;

  // Auto-scroll when watching and new messages arrive
  createEffect(() => {
    if (activeTab() === "watch" && props.watchedMessages.length > 0 && scrollRef) {
      scrollRef.scrollTop = scrollRef.scrollHeight;
    }
  });

  return (
    <Show when={props.open}>
      <div class="fixed inset-y-0 right-0 z-40 w-[400px] flex flex-col bg-gray-1 border-l border-gray-6 shadow-2xl animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div class="flex items-center justify-between px-4 py-3 border-b border-gray-6 bg-gray-2">
          <h3 class="text-sm font-semibold text-gray-12">Delegation</h3>
          <button
            onClick={props.onClose}
            class="p-1.5 rounded-full hover:bg-gray-4 text-gray-10 hover:text-gray-12 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Tab bar */}
        <div class="flex border-b border-gray-6">
          <button
            class={`flex-1 px-4 py-2.5 text-xs font-medium transition-colors ${
              activeTab() === "context"
                ? "text-indigo-11 border-b-2 border-indigo-7"
                : "text-gray-10 hover:text-gray-12"
            }`}
            onClick={() => setActiveTab("context")}
          >
            <FileText size={12} class="inline mr-1.5" />
            Context
          </button>
          <button
            class={`flex-1 px-4 py-2.5 text-xs font-medium transition-colors ${
              activeTab() === "watch"
                ? "text-indigo-11 border-b-2 border-indigo-7"
                : "text-gray-10 hover:text-gray-12"
            }`}
            onClick={() => {
              setActiveTab("watch");
              if (!props.isWatching) props.onStartWatch();
            }}
          >
            <Eye size={12} class="inline mr-1.5" />
            Watch
          </button>
        </div>

        {/* Content */}
        <div class="flex-1 overflow-hidden">
          {/* Context tab */}
          <Show when={activeTab() === "context"}>
            <div class="h-full overflow-y-auto p-4 space-y-3">
              <Show when={props.context} fallback={
                <div class="text-sm text-gray-9 text-center py-8">Loading context...</div>
              }>
                {(ctx) => (
                  <>
                    <div class="flex items-center gap-3 text-xs text-gray-10">
                      <span class="flex items-center gap-1">
                        <MessageSquare size={12} />
                        {ctx().messageCount} messages
                      </span>
                      <span class="flex items-center gap-1">
                        <Wrench size={12} />
                        {ctx().toolCallCount} tool calls
                      </span>
                    </div>
                    <div class="space-y-2">
                      <For each={ctx().messages}>
                        {(msg) => (
                          <div class="rounded-lg border border-gray-6 bg-gray-2 p-3">
                            <div class="text-[10px] font-medium uppercase tracking-wider text-gray-9 mb-1">
                              {msg.role}
                            </div>
                            <div class="text-xs text-gray-11 line-clamp-3">
                              {msg.content.slice(0, 200)}{msg.content.length > 200 ? "..." : ""}
                            </div>
                          </div>
                        )}
                      </For>
                    </div>
                  </>
                )}
              </Show>
            </div>
          </Show>

          {/* Watch tab */}
          <Show when={activeTab() === "watch"}>
            <div ref={scrollRef} class="h-full overflow-y-auto p-4 space-y-3">
              <Show when={props.watchedMessages.length === 0}>
                <div class="text-sm text-gray-9 text-center py-8">
                  {props.isWatching ? "Waiting for Pixie to respond..." : "Click Watch to start"}
                </div>
              </Show>
              <For each={props.watchedMessages}>
                {(msg) => (
                  <div class={`rounded-lg border p-3 ${
                    msg.info.role === "assistant"
                      ? "border-violet-6/30 bg-violet-2/20"
                      : "border-gray-6 bg-gray-2"
                  }`}>
                    <div class="text-[10px] font-medium uppercase tracking-wider text-gray-9 mb-1">
                      {msg.info.role === "assistant" ? "Pixie" : msg.info.role}
                    </div>
                    <div class="text-xs text-gray-11 space-y-1">
                      <For each={msg.parts}>
                        {(part: any) => (
                          <Show when={part.type === "text" && part.text}>
                            <div class="whitespace-pre-wrap">{(part as any).text}</div>
                          </Show>
                        )}
                      </For>
                      <For each={msg.parts}>
                        {(part: any) => (
                          <Show when={part.type === "tool-invocation"}>
                            <div class="text-[10px] text-gray-9 font-mono bg-gray-3 px-2 py-1 rounded">
                              Tool: {(part as any).toolInvocation?.toolName ?? "unknown"}
                            </div>
                          </Show>
                        )}
                      </For>
                    </div>
                  </div>
                )}
              </For>
              <Show when={props.isWatching && (props.watchRunPhase === "sending" || props.watchRunPhase === "thinking" || props.watchRunPhase === "responding")}>
                <div class="flex items-center gap-2 text-xs text-gray-10 py-2">
                  <div class="h-1.5 w-1.5 rounded-full bg-violet-8 animate-pulse" />
                  <span>Pixie is {props.watchRunPhase === "responding" ? "responding" : "thinking"}...</span>
                </div>
              </Show>
            </div>
          </Show>
        </div>

        {/* Footer */}
        <Show when={activeTab() === "watch" && props.isWatching}>
          <div class="border-t border-gray-6 p-3">
            <button
              onClick={() => { props.onStopWatch(); setActiveTab("context"); }}
              class="w-full px-3 py-2 text-xs font-medium text-gray-10 hover:text-gray-12 bg-gray-3 hover:bg-gray-4 rounded-lg transition-colors"
            >
              Stop Watching
            </button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
