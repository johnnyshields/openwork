import { Show, For, createSignal, createEffect, onCleanup } from "solid-js";
import { CheckCircle2, Loader2, XCircle, X } from "lucide-solid";
import type { DelegationProgress } from "../types";
import Button from "./button";

export default function DelegationProgressOverlay(props: {
  progress: DelegationProgress;
  onCancel: () => void;
  onRetry?: () => void;
  onContinueAnyway?: () => void;
  onKeepWaiting?: () => void;
  onViewConversation?: () => void;
}) {
  const [elapsed, setElapsed] = createSignal(0);

  createEffect(() => {
    const start = props.progress.startedAt;
    const update = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    update();
    const id = setInterval(update, 1000);
    onCleanup(() => clearInterval(id));
  });

  const hasError = () => props.progress.steps.some((s) => s.status === "error");
  const errorStep = () => props.progress.steps.find((s) => s.status === "error");

  const isContainerError = () => {
    const step = errorStep();
    return step && step.key === "container";
  };

  const isConnectError = () => {
    const step = errorStep();
    return step && step.key === "connect";
  };

  return (
    <div class="fixed inset-0 z-[60] overflow-hidden bg-gray-1 text-gray-12 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      {/* Background */}
      <div class="absolute inset-0">
        <div class="absolute inset-0 bg-[radial-gradient(circle_at_top,_var(--tw-gradient-stops))] from-gray-2 via-gray-1 to-gray-1 opacity-80" />
        <div
          class="absolute -top-24 right-[-4rem] h-72 w-72 rounded-full bg-indigo-7/20 blur-3xl motion-safe:animate-pulse motion-reduce:opacity-40"
          style={{ "animation-duration": "6s" }}
        />
        <div
          class="absolute -bottom-28 left-[-5rem] h-80 w-80 rounded-full bg-indigo-6/15 blur-3xl motion-safe:animate-pulse motion-reduce:opacity-40"
          style={{ "animation-duration": "8s" }}
        />
        <div class="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-gray-1 via-gray-1/40 to-transparent" />
      </div>

      {/* Content */}
      <div class="relative z-10 flex min-h-screen flex-col items-center justify-center px-6 py-10 text-center">
        <div class="flex flex-col items-center gap-8">
          {/* Title */}
          <div class="space-y-2">
            <h2 class="text-2xl font-semibold tracking-tight">Delegating to Pixie</h2>
            <p class="text-sm text-gray-10">Setting up remote workspace</p>
          </div>

          {/* Steps */}
          <div class="w-72 grid gap-2.5">
            <For each={props.progress.steps}>
              {(step) => {
                const icon = () => {
                  if (step.status === "done") return <CheckCircle2 size={16} class="text-emerald-10" />;
                  if (step.status === "active") return <Loader2 size={16} class="text-indigo-11 animate-spin" />;
                  if (step.status === "error") return <XCircle size={16} class="text-red-10" />;
                  return <div class="w-4 h-4 rounded-full border-2 border-gray-6" />;
                };

                const textClass = () => {
                  if (step.status === "done") return "text-gray-11 font-medium";
                  if (step.status === "active") return "text-gray-12 font-semibold";
                  if (step.status === "error") return "text-red-11 font-medium";
                  return "text-gray-9";
                };

                return (
                  <div>
                    <div class="flex items-center gap-3">
                      <div class="shrink-0 flex items-center justify-center w-5 h-5">
                        {icon()}
                      </div>
                      <div class="min-w-0 flex-1 flex items-center justify-between gap-2">
                        <div class={`text-xs ${textClass()} transition-colors duration-200`.trim()}>{step.label}</div>
                        <Show when={step.status !== "error" && (step.detail ?? "").trim()}>
                          <div class="text-[10px] text-gray-9 font-mono truncate max-w-[120px] bg-gray-3/50 px-1.5 py-0.5 rounded">
                            {step.detail}
                          </div>
                        </Show>
                      </div>
                    </div>
                    <Show when={step.status === "error" && (step.detail ?? "").trim()}>
                      <div class="ml-8 mt-1.5 rounded-md border border-red-6 bg-red-3/30 px-3 py-2 text-left">
                        <p class="text-[11px] text-red-11 font-mono leading-relaxed">{step.detail}</p>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>

          {/* Elapsed timer */}
          <div class="text-[11px] text-gray-8 font-mono">{elapsed()}s</div>

          {/* Shimmer bar */}
          <div class="h-1 w-56 overflow-hidden rounded-full bg-gray-4/50">
            <div class="h-full w-1/2 rounded-full bg-gradient-to-r from-transparent via-indigo-6/50 to-transparent animate-progress-shimmer" />
          </div>

          {/* Footer buttons */}
          <div class="flex items-center gap-3">
            <Button variant="ghost" onClick={props.onCancel}>
              <X size={14} />
              Cancel
            </Button>

            <Show when={isContainerError()}>
              <Show when={props.onRetry}>
                <Button variant="outline" onClick={props.onRetry}>Retry</Button>
              </Show>
              <Show when={props.onContinueAnyway}>
                <Button variant="outline" onClick={props.onContinueAnyway}>Continue Anyway</Button>
              </Show>
            </Show>

            <Show when={isConnectError()}>
              <Show when={props.onKeepWaiting}>
                <Button variant="outline" onClick={props.onKeepWaiting}>Keep Waiting</Button>
              </Show>
              <Show when={props.onViewConversation}>
                <Button variant="primary" onClick={props.onViewConversation}>View Conversation</Button>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
}
