"use client";

import * as React from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import { MessageSquarePlus, MoreHorizontal, Pencil, Pin, PinOff, Plus, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/button";
import { Input, SearchInput } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const SQUIRCLE = "[corner-shape:squircle]";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SPRING = {
  type: "spring",
  stiffness: 420,
  damping: 34,
  mass: 0.8,
} as const;

const FOLD = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["figure", "title", "body", "sub", "dense", "meta", "chip", "micro"] }],
      shadow: [{ shadow: ["float", "overlay"] }],
    },
  },
});

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export interface Conversation {
  id: string;
  title: string;
  /** When it was last active. Decides the group. */
  updatedAt: Date | string | number;
  pinned?: boolean;
  /** A line of the last message, searched along with the title. */
  preview?: string;
  /** A reply has arrived that has not been read. */
  unread?: boolean;
  /** An answer is being written in it right now. */
  streaming?: boolean;
}

export interface ConversationHistoryProps extends Omit<React.HTMLAttributes<HTMLElement>, "onSelect" | "title"> {
  conversations: Conversation[];
  activeId?: string;
  onSelect?: (id: string) => void;
  /** Leave it out to hide the New conversation button. */
  onNew?: () => void;
  /** Leave any of these three out to remove it from the row's menu. */
  onRename?: (id: string, title: string) => void;
  onPin?: (id: string, pinned: boolean) => void;
  onDelete?: (id: string) => void;
  /** The search box. Default true. */
  search?: boolean;
  /** Skeleton rows while the list is fetched. */
  loading?: boolean;
  /** "Today" is measured from here. Default: now. */
  now?: Date;
  /** The heading. Default "Chats". */
  title?: React.ReactNode;
}

const DAY = 86_400_000;

function bucket(at: Date, now: Date) {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = at.getTime();
  if (t >= start) return "Today";
  if (t >= start - DAY) return "Yesterday";
  if (t >= start - 7 * DAY) return "Previous 7 days";
  if (t >= start - 30 * DAY) return "Previous 30 days";
  return "Older";
}

const ORDER = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"];

function Marked({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-warning-fill/35 text-inherit">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

function excerpt(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  return at > 18 ? `…${text.slice(at - 12)}` : text;
}

export const ConversationHistory = React.forwardRef<HTMLElement, ConversationHistoryProps>(function ConversationHistory(
  {
    conversations,
    activeId,
    onSelect,
    onNew,
    onRename,
    onPin,
    onDelete,
    search = true,
    loading = false,
    now,
    title = "Chats",
    className,
    ...props
  },
  ref,
) {
  const reduce = useReducedMotion();
  const groupId = React.useId();
  const [query, setQuery] = React.useState("");
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  const [confirming, setConfirming] = React.useState<string | null>(null);
  const list = React.useRef<HTMLDivElement>(null);

  const today = React.useMemo(() => now ?? new Date(), [now]);

  const groups = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q
      ? conversations.filter((c) => c.title.toLowerCase().includes(q) || c.preview?.toLowerCase().includes(q))
      : conversations;
    const by = new Map<string, Conversation[]>();
    for (const c of [...hits].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt))) {
      const key = c.pinned ? "Pinned" : bucket(new Date(c.updatedAt), today);
      by.set(key, [...(by.get(key) ?? []), c]);
    }
    return ORDER.filter((k) => by.has(k)).map((k) => ({ label: k, items: by.get(k)! }));
  }, [conversations, query, today]);

  const count = groups.reduce((n, g) => n + g.items.length, 0);

  const startRename = (c: Conversation) => {
    setConfirming(null);
    setDraft(c.title);
    setRenaming(c.id);
  };
  const commitRename = (c: Conversation) => {
    const next = draft.trim();
    if (next && next !== c.title) onRename?.(c.id, next);
    setRenaming(null);
  };
  const refocus = (id: string) =>
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`)?.focus());

  const onKeys = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
    if (!row || (e.target as HTMLElement).tagName === "INPUT") return;
    const rows = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    const at = rows.indexOf(row);
    const c = conversations.find((x) => x.id === row.dataset.row);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      rows[e.key === "Home" ? 0 : rows.length - 1]?.focus();
    } else if (e.key === "F2" && c && onRename) {
      e.preventDefault();
      startRename(c);
    } else if ((e.key === "Delete" || e.key === "Backspace") && c && onDelete) {
      e.preventDefault();
      setConfirming(c.id);
    }
  };

  const hasMenu = Boolean(onRename || onPin || onDelete);

  return (
    <nav
      ref={ref}
      aria-label={typeof title === "string" ? title : "Conversations"}
      className={cn("flex h-full min-h-0 w-full flex-col text-foreground", className)}
      {...props}
    >
      <div className="flex shrink-0 flex-col gap-1.5 px-2 pt-2 pb-2">
        <h2 className="sr-only">{title}</h2>
        {onNew && (
          <button
            type="button"
            onClick={onNew}
            className={cn(
              "group/new flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-1.5 text-left text-[13.5px] font-medium transition-colors hover:bg-foreground/5",
              FOCUS,
              SQUIRCLE,
            )}
          >
            <span
              aria-hidden
              className="grid size-6 shrink-0 place-items-center rounded-full bg-foreground/[0.07] transition-colors group-hover/new:bg-foreground group-hover/new:text-background [&_svg]:size-3.5"
            >
              <Plus />
            </span>
            New chat
          </button>
        )}
        {search && (
          <SearchInput size="sm" value={query} onValueChange={setQuery} placeholder="Search chats" aria-label="Search chats" />
        )}
      </div>

      <div
        ref={list}
        onKeyDown={onKeys}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-3 [mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]"
      >
        {loading ? (
          <div aria-busy className="flex flex-col gap-3 px-1.5 pt-2">
            <span className="sr-only">Loading conversations</span>
            {[72, 88, 60, 80, 54, 76].map((w, i) => (
              <Skeleton key={i} className="h-3.5" style={{ width: `${w}%` }} />
            ))}
          </div>
        ) : count === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 pt-10 text-center">
            <p className="text-[13px] font-medium">{query ? "No chats match that" : "No conversations yet"}</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {query ? `Nothing has “${query.trim()}” in its title or last message.` : "Ask something and it will be kept here."}
            </p>
            {query ? (
              <Button size="sm" variant="outline" onClick={() => setQuery("")} className="mt-1">
                Clear search
              </Button>
            ) : (
              onNew && (
                <Button size="sm" onClick={onNew} className="mt-1">
                  <MessageSquarePlus />
                  New chat
                </Button>
              )
            )}
          </div>
        ) : (
          <LayoutGroup id={groupId}>
            <div role="list" className="flex flex-col">
              <AnimatePresence initial={false} mode="popLayout">
                {groups.flatMap((g) => [
                  <motion.p
                    key={`h-${g.label}`}
                    layout={reduce ? false : "position"}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={SPRING}
                    className="px-1.5 pt-3 pb-1 text-[12px] font-medium text-muted-foreground first:pt-1"
                  >
                    {g.label}
                  </motion.p>,
                  ...g.items.map((c) => {
                    const on = c.id === activeId;
                    const q = query.trim();
                    const inPreview =
                      q !== "" && !c.title.toLowerCase().includes(q.toLowerCase()) && Boolean(c.preview?.toLowerCase().includes(q.toLowerCase()));
                    const asking = confirming === c.id;
                    const editing = renaming === c.id;
                    return (
                      <motion.div
                        key={c.id}
                        role="listitem"
                        layout={reduce ? false : "position"}
                        initial={reduce ? false : { opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={reduce ? { opacity: 0 } : { opacity: 0, height: 0 }}
                        transition={FOLD}
                        className="group/row relative"
                      >
                        {on && !asking && (
                          <motion.span
                            aria-hidden
                            layoutId="active"
                            transition={reduce ? { duration: 0 } : SPRING}
                            className={cn("absolute inset-0 rounded-[9px] bg-accent", SQUIRCLE)}
                          />
                        )}

                        {asking ? (
                          <motion.div
                            role="alertdialog"
                            aria-label={`Delete ${c.title}?`}
                            initial={reduce ? false : { opacity: 0 }}
                            animate={{ opacity: 1 }}
                            className={cn(
                              "relative flex h-9 items-center gap-1.5 rounded-[9px] bg-destructive-soft pr-1 pl-2.5 text-[13px] ring-1 ring-inset ring-destructive/20",
                              SQUIRCLE,
                            )}
                          >
                            <span className="min-w-0 flex-1 truncate font-medium text-destructive">Delete this chat?</span>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2"
                              onClick={() => {
                                setConfirming(null);
                                refocus(c.id);
                              }}
                            >
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 px-2"
                              autoFocus
                              onClick={() => {
                                setConfirming(null);
                                onDelete?.(c.id);
                              }}
                            >
                              Delete
                            </Button>
                          </motion.div>
                        ) : editing ? (
                          <Input
                            size="sm"
                            autoFocus
                            aria-label="Rename conversation"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onFocus={(e) => e.currentTarget.select()}
                            onBlur={() => commitRename(c)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitRename(c);
                                refocus(c.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                setRenaming(null);
                                refocus(c.id);
                              }
                            }}
                            className="relative h-9 rounded-[9px] px-2.5 text-[13px]"
                          />
                        ) : (
                          <div className="relative flex min-h-9 items-start">
                            <button
                              type="button"
                              data-row={c.id}
                              aria-current={on ? "page" : undefined}
                              onClick={() => onSelect?.(c.id)}
                              onDoubleClick={() => onRename && startRename(c)}
                              className={cn(
                                "flex min-h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[9px] py-1.5 pr-8 pl-2.5 text-left text-[13px] transition-colors",
                                on ? "font-medium text-foreground" : "text-foreground/80 hover:bg-accent/60 hover:text-foreground",
                                FOCUS,
                                SQUIRCLE,
                              )}
                            >
                              {c.pinned && <Pin aria-hidden className="size-3 shrink-0 -rotate-45 text-muted-foreground" />}
                              <span className="min-w-0 flex-1">
                                <span className="block truncate">
                                  <Marked text={c.title} query={q} />
                                </span>
                                {inPreview && (
                                  <span className="block truncate text-[12px] font-normal text-muted-foreground">
                                    <Marked text={excerpt(c.preview!, q)} query={q} />
                                  </span>
                                )}
                              </span>
                              {c.streaming ? (
                                <span aria-label="Answering" className="flex shrink-0 items-center gap-[3px]">
                                  {[0, 1, 2].map((i) => (
                                    <span
                                      key={i}
                                      style={{ animationDelay: `${i * 0.16}s` }}
                                      className="size-1 rounded-full bg-foreground/60 motion-safe:animate-dot"
                                    />
                                  ))}
                                </span>
                              ) : (
                                c.unread && <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-[var(--status-unread,var(--color-info))]" />
                              )}
                            </button>

                            {hasMenu && (
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <IconButton
                                    label={`Options for ${c.title}`}
                                    className={cn(
                                      "absolute top-1 right-1 size-7 rounded-[7px] text-muted-foreground opacity-0 transition-[opacity,background-color]",
                                      "hover:bg-foreground/10 hover:text-foreground group-hover/row:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100",
                                    )}
                                  >
                                    <MoreHorizontal />
                                  </IconButton>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start" className="min-w-[168px]" onCloseAutoFocus={(e) => e.preventDefault()}>
                                  {onRename && (
                                    <DropdownMenuItem shortcut="F2" onSelect={() => startRename(c)}>
                                      <Pencil />
                                      Rename
                                    </DropdownMenuItem>
                                  )}
                                  {onPin && (
                                    <DropdownMenuItem onSelect={() => onPin(c.id, !c.pinned)}>
                                      {c.pinned ? <PinOff /> : <Pin />}
                                      {c.pinned ? "Unpin" : "Pin"}
                                    </DropdownMenuItem>
                                  )}
                                  {onDelete && (
                                    <>
                                      {(onRename || onPin) && <DropdownMenuSeparator />}
                                      <DropdownMenuItem danger shortcut="Del" onSelect={() => setConfirming(c.id)}>
                                        <Trash2 />
                                        Delete
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            )}
                          </div>
                        )}
                      </motion.div>
                    );
                  }),
                ])}
              </AnimatePresence>
            </div>
          </LayoutGroup>
        )}
      </div>

      <span role="status" className="sr-only">
        {query ? `${count} ${count === 1 ? "chat" : "chats"} found` : ""}
      </span>
    </nav>
  );
});

export default ConversationHistory;
