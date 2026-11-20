"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CircleAlert, X } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const SQUIRCLE = "[corner-shape:squircle]";

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

export interface TagInputProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange" | "defaultValue"> {
  /** The valid values, controlled. */
  value?: string[];
  /** The valid values to start with, uncontrolled. */
  defaultValue?: string[];
  /** Called with the valid values whenever they change. */
  onChange?: (values: string[]) => void;
  /** Returns why a value is wrong, or nothing when it is fine. */
  validate?: (value: string) => string | undefined | null | false;
  /** The most values allowed. */
  max?: number;
  /** The field's label. Required: a chip field without one reads as nothing to a screen reader. */
  label: string;
  /** A short line under the field. */
  hint?: string;
  placeholder?: string;
  /** Completions shown while typing. */
  suggestions?: string[];
  /** Treat "Ana" and "ana" as different values. Default false. */
  caseSensitive?: boolean;
  disabled?: boolean;
  /** Rewrites a value before it is checked: trim and lower-case emails, say. Default: trim. */
  normalize?: (value: string) => string;
}

type Chip = { id: number; text: string; error?: string };

const SPLIT = /[,\n\t;]+/;

export const TagInput = React.forwardRef<HTMLDivElement, TagInputProps>(function TagInput(
  { value, defaultValue, onChange, validate, max, label, hint, placeholder = "Type and press Enter", suggestions, caseSensitive = false, disabled, normalize, className, ...rest },
  ref,
) {
  const reduced = useReducedMotion();
  const uid = React.useId();
  const seq = React.useRef(0);
  const make = (text: string, error?: string): Chip => ({ id: ++seq.current, text, error });
  const [chips, setChips] = React.useState<Chip[]>(() => (value ?? defaultValue ?? []).map((t) => make(t, validate?.(t) || undefined)));
  const [draft, setDraft] = React.useState("");
  const [focusIdx, setFocusIdx] = React.useState<number | null>(null);
  const [editing, setEditing] = React.useState<number | null>(null);
  const [editText, setEditText] = React.useState("");
  const [flash, setFlash] = React.useState<number | null>(null);
  const [overflow, setOverflow] = React.useState<string[]>([]);
  const [note, setNote] = React.useState("");
  const [active, setActive] = React.useState(0);
  const input = React.useRef<HTMLInputElement>(null);
  const chipRefs = React.useRef<Array<HTMLElement | null>>([]);

  const lastSent = React.useRef<string[] | undefined>(value);
  React.useEffect(() => {
    if (value == null || value === lastSent.current) return;
    lastSent.current = value;
    setChips((cs) => [...value.map((t) => make(t)), ...cs.filter((c) => c.error)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const norm = (s: string) => (normalize ? normalize(s) : s.trim());
  const key = (s: string) => (caseSensitive ? s : s.toLowerCase());

  const commit = (next: Chip[]) => {
    setChips(next);
    const valid = next.filter((c) => !c.error).map((c) => c.text);
    lastSent.current = valid;
    onChange?.(valid);
  };

  const add = (raw: string[]) => {
    let next = [...chips];
    const left: string[] = [];
    let dupes = 0;
    let bad = 0;
    for (const r of raw) {
      const t = norm(r);
      if (!t) continue;
      const existing = next.find((c) => key(c.text) === key(t));
      if (existing) {
        dupes++;
        setFlash(existing.id);
        continue;
      }
      if (max != null && next.filter((c) => !c.error).length >= max) {
        left.push(t);
        continue;
      }
      const err = validate?.(t) || undefined;
      if (err) bad++;
      next = [...next, make(t, err)];
    }
    commit(next);
    setOverflow(left);
    const parts = [];
    if (dupes) parts.push(`${dupes} already in the list`);
    if (bad) parts.push(`${bad} need${bad === 1 ? "s" : ""} fixing`);
    setNote(parts.length ? parts.join(", ") + "." : "");
  };

  React.useEffect(() => {
    if (flash == null) return;
    const t = setTimeout(() => setFlash(null), 700);
    return () => clearTimeout(t);
  }, [flash]);

  const remove = (i: number) => {
    const next = chips.filter((_, j) => j !== i);
    commit(next);
    if (!next.length) {
      setFocusIdx(null);
      input.current?.focus();
    } else {
      const k = Math.min(i, next.length - 1);
      setFocusIdx(k);
      requestAnimationFrame(() => chipRefs.current[k]?.focus());
    }
  };

  const startEdit = (i: number) => {
    if (disabled) return;
    setEditing(i);
    setEditText(chips[i].text);
  };
  const finishEdit = (save: boolean) => {
    if (editing == null) return;
    const i = editing;
    setEditing(null);
    if (!save) return requestAnimationFrame(() => chipRefs.current[i]?.focus());
    const t = norm(editText);
    if (!t) return remove(i);
    const clash = chips.find((c, j) => j !== i && key(c.text) === key(t));
    if (clash) {
      setFlash(clash.id);
      setNote(`“${t}” is already in the list.`);
      return;
    }
    const err = validate?.(t) || undefined;
    commit(chips.map((c, j) => (j === i ? { ...c, text: t, error: err } : c)));
    setNote(err ? "" : note);
    requestAnimationFrame(() => input.current?.focus());
  };

  const matches = React.useMemo(() => {
    const q = key(draft.trim());
    if (!q || !suggestions) return [];
    const have = new Set(chips.map((c) => key(c.text)));
    return suggestions.filter((s) => key(s).includes(q) && !have.has(key(s))).slice(0, 6);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, suggestions, chips, caseSensitive]);
  React.useEffect(() => setActive(0), [draft]);

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
      return;
    }
    if (e.key === "Enter" || e.key === "," || e.key === ";" || (e.key === "Tab" && draft.trim())) {
      if (!draft.trim() && e.key === "Enter") return;
      e.preventDefault();
      add([matches.length && e.key !== "," ? matches[active] : draft]);
      setDraft("");
      return;
    }
    if (e.key === "Escape" && draft) {
      setDraft("");
      return;
    }
    if ((e.key === "Backspace" || e.key === "ArrowLeft") && !draft && chips.length && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      const k = chips.length - 1;
      setFocusIdx(k);
      chipRefs.current[k]?.focus();
    }
  };

  const onChipKey = (e: React.KeyboardEvent, i: number) => {
    if (e.key === "ArrowLeft" && i > 0) {
      e.preventDefault();
      setFocusIdx(i - 1);
      chipRefs.current[i - 1]?.focus();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      if (i < chips.length - 1) {
        setFocusIdx(i + 1);
        chipRefs.current[i + 1]?.focus();
      } else {
        setFocusIdx(null);
        input.current?.focus();
      }
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      remove(i);
    } else if (e.key === "Enter" || e.key === "F2") {
      e.preventDefault();
      startEdit(i);
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      setFocusIdx(null);
      input.current?.focus();
    }
  };

  const invalid = chips.filter((c) => c.error);
  const validCount = chips.length - invalid.length;
  const listId = `${uid}-list`;
  const pop = reduced ? { duration: 0 } : { type: "spring" as const, stiffness: 520, damping: 32, mass: 0.6 };

  return (
    <div ref={ref} className={cn("w-full max-w-[520px]", className)} {...rest}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <label htmlFor={`${uid}-in`} className="text-[13px] font-medium">
          {label}
        </label>
        {max != null && (
          <span className={cn("text-[11.5px] tabular-nums", validCount >= max ? "text-warning" : "text-muted-foreground")} aria-live="polite">
            {validCount} of {max}
          </span>
        )}
      </div>

      <div className="relative">
        <div
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              e.preventDefault();
              input.current?.focus();
            }
          }}
          aria-invalid={invalid.length > 0 || undefined}
          className={cn(
            "flex min-h-10 w-full cursor-text flex-wrap items-center gap-1.5 rounded-[11px] bg-card px-1.5 py-1.5 ring-1 ring-inset ring-input transition-[box-shadow] hover:ring-foreground/25 focus-within:ring-2 focus-within:ring-ring",
            "aria-invalid:ring-destructive/50 aria-invalid:focus-within:ring-destructive/50",
            disabled && "pointer-events-none opacity-[0.7]",
            SQUIRCLE,
          )}
        >
          <ul className="contents" aria-label={`${label}: ${chips.length} value${chips.length === 1 ? "" : "s"}`}>
            <AnimatePresence initial={false} mode="popLayout">
              {chips.map((c, i) => (
                <motion.li
                  key={c.id}
                  layout={reduced ? false : "position"}
                  initial={reduced ? false : { opacity: 0, scale: 0.7 }}
                  animate={{ opacity: 1, scale: 1, x: flash === c.id && !reduced ? [0, -3, 3, -2, 2, 0] : 0 }}
                  exit={reduced ? undefined : { opacity: 0, scale: 0.7, transition: { duration: 0.14 } }}
                  transition={{ ...pop, x: { duration: reduced ? 0 : 0.42, ease: "easeInOut" } }}
                  className="max-w-full"
                >
                  {editing === i ? (
                    <input
                      autoFocus
                      aria-label={`Edit ${c.text}`}
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onBlur={() => finishEdit(true)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          finishEdit(true);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          finishEdit(false);
                        }
                      }}
                      style={{ width: `${Math.max(6, editText.length + 1)}ch` }}
                      className={cn("h-7 max-w-full rounded-[8px] bg-card px-2 text-[13px] ring-2 ring-ring outline-none", SQUIRCLE)}
                    />
                  ) : (
                    <span
                      ref={(el) => {
                        chipRefs.current[i] = el;
                      }}
                      role="button"
                      tabIndex={focusIdx === i ? 0 : -1}
                      aria-label={`${c.text}${c.error ? `, ${c.error}` : ""}. Enter to edit, Backspace to remove.`}
                      aria-invalid={c.error ? true : undefined}
                      onKeyDown={(e) => onChipKey(e, i)}
                      onFocus={() => setFocusIdx(i)}
                      onDoubleClick={() => startEdit(i)}
                      title={c.error}
                      className={cn(
                        "group relative inline-flex h-7 max-w-full items-center gap-1 rounded-[8px] pr-1 pl-2 text-[13px] transition-colors outline-none select-none",
                        "focus-visible:ring-2 focus-visible:ring-ring",
                        c.error ? "bg-destructive-soft text-destructive ring-1 ring-inset ring-destructive/25 dark:text-[color-mix(in_oklab,var(--destructive)_72%,white)]" : "bg-muted text-foreground ring-1 ring-inset ring-border",
                        flash === c.id && "bg-warning-soft ring-warning/50",
                        SQUIRCLE,
                      )}
                    >
                      {c.error && <CircleAlert className="size-3.5 shrink-0" aria-hidden />}
                      <span className="truncate">{c.text}</span>
                      <span
                        aria-hidden
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => remove(i)}
                        className="grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] opacity-60 transition-opacity hover:bg-foreground/10 hover:opacity-100"
                      >
                        <X className="size-3" />
                      </span>
                    </span>
                  )}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <input
            ref={input}
            id={`${uid}-in`}
            value={draft}
            disabled={disabled}
            placeholder={chips.length ? "" : placeholder}
            onChange={(e) => {
              const v = e.target.value;
              if (SPLIT.test(v)) {
                const parts = v.split(SPLIT);
                const rest2 = parts.pop() ?? "";
                add(parts);
                setDraft(rest2);
              } else setDraft(v);
            }}
            onPaste={(e) => {
              const text = e.clipboardData.getData("text");
              if (!SPLIT.test(text)) return;
              e.preventDefault();
              add(text.split(SPLIT));
            }}
            onKeyDown={onInputKey}
            onFocus={() => setFocusIdx(null)}
            onBlur={() => {
              if (draft.trim()) {
                add([draft]);
                setDraft("");
              }
            }}
            role="combobox"
            aria-expanded={matches.length > 0}
            aria-controls={listId}
            aria-activedescendant={matches.length ? `${listId}-${active}` : undefined}
            aria-describedby={`${uid}-hint`}
            className="h-7 min-w-[8ch] flex-1 bg-transparent px-1.5 text-[13px] outline-none placeholder:text-muted-foreground"
          />
        </div>

        <AnimatePresence>
          {matches.length > 0 && (
            <motion.ul
              id={listId}
              role="listbox"
              aria-label="Suggestions"
              initial={reduced ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduced ? undefined : { opacity: 0, y: -4 }}
              transition={{ duration: reduced ? 0 : 0.14 }}
              className={cn("absolute top-full right-0 left-0 z-10 mt-1.5 overflow-hidden rounded-[12px] bg-popover p-1 text-popover-foreground shadow-float ring-1 ring-border", SQUIRCLE)}
            >
              {matches.map((m, i) => (
                <li
                  key={m}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    add([m]);
                    setDraft("");
                  }}
                  onMouseEnter={() => setActive(i)}
                  className={cn("cursor-pointer rounded-[8px] px-2.5 py-1.5 text-[13px]", i === active && "bg-accent")}
                >
                  {m}
                </li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </div>

      <div id={`${uid}-hint`} className="mt-1.5 space-y-1 text-[12px]">
        <AnimatePresence initial={false}>
          {invalid.length > 0 && (
            <motion.div
              key="invalid"
              role="alert"
              initial={reduced ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={reduced ? undefined : { opacity: 0, height: 0 }}
              className="overflow-hidden text-destructive"
            >
              <ul className="space-y-0.5">
                {invalid.slice(0, 3).map((c) => (
                  <li key={c.id}>
                    <span className="font-medium">{c.text}</span>: {c.error}
                  </li>
                ))}
              </ul>
              <span className="text-[var(--muted-foreground-2,var(--muted-foreground))]">
                {invalid.length > 3 ? `and ${invalid.length - 3} more. ` : ""}Double-click a red value to fix it, or Backspace to remove it.
              </span>
            </motion.div>
          )}
          {overflow.length > 0 && (
            <motion.div
              key="overflow"
              role="status"
              initial={reduced ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={reduced ? undefined : { opacity: 0, height: 0 }}
              className="overflow-hidden text-warning"
            >
              {overflow.length} didn&apos;t fit the limit of {max}: <span className="text-[var(--muted-foreground-2,var(--muted-foreground))]">{overflow.join(", ")}</span>
            </motion.div>
          )}
        </AnimatePresence>
        {(note || hint) && (
          <div aria-live="polite" className="text-muted-foreground">
            {note || hint}
          </div>
        )}
      </div>
    </div>
  );
});

export default TagInput;
