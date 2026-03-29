import { Show, createSignal, onCleanup } from "solid-js";
import { GitBranch, ChevronDown, ChevronUp, X } from "lucide-solid";

export default function DelegationChangesBanner(props: {
  stat: string;
  onDismiss: () => void;
}) {
  // Parse the git diff --stat summary line
  // Example: " 3 files changed, 45 insertions(+), 12 deletions(-)"
  const summary = () => {
    const lines = props.stat.trim().split("\n");
    const last = lines[lines.length - 1] ?? "";
    const filesMatch = last.match(/(\d+) files? changed/);
    const insertMatch = last.match(/(\d+) insertions?\(\+\)/);
    const deleteMatch = last.match(/(\d+) deletions?\(-\)/);
    return {
      files: filesMatch ? parseInt(filesMatch[1]) : 0,
      insertions: insertMatch ? parseInt(insertMatch[1]) : 0,
      deletions: deleteMatch ? parseInt(deleteMatch[1]) : 0,
      raw: props.stat.trim(),
    };
  };

  const [expanded, setExpanded] = createSignal(false);

  // Auto-dismiss after 30s
  const [timer] = createSignal(
    setTimeout(() => props.onDismiss(), 30_000)
  );
  onCleanup(() => clearTimeout(timer()));

  return (
    <div class="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[min(520px,calc(100vw-2rem))]">
      <div class="flex flex-col rounded-2xl border border-gray-6/50 bg-gray-2/95 shadow-xl backdrop-blur-md animate-in fade-in slide-in-from-top-4 duration-300">
        <div class="flex items-center gap-3 p-2 pr-3">
          <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-3 text-emerald-11">
            <GitBranch size={16} />
          </div>
          <div class="flex-1 min-w-0">
            <span class="text-sm font-medium text-gray-12">
              Pixie changed {summary().files} file{summary().files !== 1 ? "s" : ""}
            </span>
            <span class="text-xs text-gray-10 ml-2">
              <span class="text-green-11">+{summary().insertions}</span>
              <span class="text-gray-8 mx-1">/</span>
              <span class="text-red-11">-{summary().deletions}</span>
            </span>
          </div>
          <div class="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setExpanded(v => !v)}
              class="px-2 py-1.5 text-xs font-medium text-gray-10 hover:text-gray-12 transition-colors"
            >
              {expanded() ? "Hide" : "View Diff"}
            </button>
            <button
              onClick={() => props.onDismiss()}
              class="p-1.5 text-gray-10 hover:text-gray-12 transition-colors rounded-full hover:bg-gray-4"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <Show when={expanded()}>
          <div class="border-t border-gray-6/50 px-4 py-3 max-h-[200px] overflow-y-auto">
            <pre class="text-[11px] font-mono text-gray-11 whitespace-pre-wrap">{summary().raw}</pre>
          </div>
        </Show>
      </div>
    </div>
  );
}
