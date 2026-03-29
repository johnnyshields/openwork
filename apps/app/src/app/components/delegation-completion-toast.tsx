import { Show, createEffect, onCleanup } from "solid-js";
import { CheckCircle2 } from "lucide-solid";
import Button from "./button";

export default function DelegationCompletionToast(props: {
  open: boolean;
  title: string;
  onView: () => void;
  onDismiss: () => void;
}) {
  // Auto-dismiss after 10s
  createEffect(() => {
    if (!props.open) return;
    const t = setTimeout(() => props.onDismiss(), 10_000);
    onCleanup(() => clearTimeout(t));
  });

  return (
    <Show when={props.open}>
      <div class="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[min(480px,calc(100vw-2rem))]">
        <div class="flex items-center gap-3 p-2 pr-3 rounded-full border border-gray-6/50 bg-gray-2/95 shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-top-4 duration-300">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-3 text-emerald-11">
            <CheckCircle2 size={16} />
          </div>
          <div class="flex-1 min-w-0 flex flex-col justify-center">
            <span class="text-sm font-medium text-gray-12 truncate">Pixie finished</span>
            <span class="text-xs text-gray-10 truncate">{props.title}</span>
          </div>
          <div class="flex items-center gap-2 shrink-0 pl-2 border-l border-gray-5/50">
            <button
              onClick={() => props.onDismiss()}
              class="px-2 py-1.5 text-xs font-medium text-gray-10 hover:text-gray-12 transition-colors"
            >
              Dismiss
            </button>
            <Button
              variant="primary"
              class="h-7 px-3 text-xs rounded-full font-medium"
              onClick={() => props.onView()}
            >
              View
            </Button>
          </div>
        </div>
      </div>
    </Show>
  );
}
