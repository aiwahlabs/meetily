"use client";

import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const SQUIRCLE = "[corner-shape:squircle]";

const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const SOFT = { type: "spring", stiffness: 300, damping: 30 } as const;

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

export interface SettingsSectionLink {
  id: string;
  title: string;
  icon?: React.ReactNode;
}

const Ctx = React.createContext<{ query: string }>({ query: "" });

export interface SettingsPageProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "title"
> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** The sections, in order, for the list on the side. Ids match each SettingsSection. */
  sections?: SettingsSectionLink[];
  /** Something has changed since the last save: shows the save bar. */
  dirty?: boolean;
  /** Save. May return a promise; throw to show why it failed. */
  onSave?: () => void | Promise<void>;
  /** Put the changes back. */
  onDiscard?: () => void;
  /** Ask before leaving with unsaved changes. Default true. */
  guardUnsaved?: boolean;
  /** Show the search box. Default true. */
  searchable?: boolean;
  saveLabel?: string;
}

export function SettingsPage({
  title,
  description,
  sections = [],
  dirty = false,
  onSave,
  onDiscard,
  guardUnsaved = true,
  searchable = true,
  saveLabel = "Save changes",
  className,
  children,
  ...props
}: SettingsPageProps) {
  const reduce = useReducedMotion();
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(sections[0]?.id);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);
  const body = React.useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = React.useState(false);
  const searchId = React.useId();

  React.useEffect(() => {
    const root = body.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort(
            (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
          )[0];
        if (top) setActive(top.target.id.replace(/^settings-/, ""));
      },
      { rootMargin: "0px 0px -60% 0px" },
    );
    root
      .querySelectorAll("[data-settings-section]")
      .forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections.length]);

  React.useEffect(() => {
    const root = body.current;
    if (!root) return;
    setEmpty(
      Boolean(query) &&
        root.querySelectorAll("[data-settings-row]:not([hidden])").length === 0,
    );
  }, [query]);

  React.useEffect(() => {
    if (!dirty || !guardUnsaved) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, guardUnsaved]);

  React.useEffect(() => {
    if (dirty) setSaved(false);
  }, [dirty]);

  const save = async () => {
    if (!onSave) return;
    setError(null);
    setSaving(true);
    try {
      await onSave();
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Your changes were not saved. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  const jump = (id: string) => {
    setActive(id);
    document
      .getElementById(`settings-${id}`)
      ?.scrollIntoView({
        behavior: reduce ? "auto" : "smooth",
        block: "start",
      });
  };

  return (
    <Ctx.Provider value={{ query: query.trim().toLowerCase() }}>
      <div
        data-settings-searching={query.trim() ? "" : undefined}
        className={cn("@container w-full text-foreground", className)}
        {...props}
      >
        {(title || description || searchable) && (
          <div className="flex flex-wrap items-end justify-between gap-3 pb-5">
            <div className="min-w-0">
              {title && (
                <h1 className="m-0 text-[20px] font-semibold tracking-[-0.015em]">
                  {title}
                </h1>
              )}
              {description && (
                <p className="m-0 mt-1 text-[13px] text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
            {searchable && (
              <label
                htmlFor={searchId}
                className="relative block w-full @min-[560px]:w-64"
              >
                <span className="sr-only">Search settings</span>
                <Search
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  id={searchId}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search settings"
                  className={cn(
                    "h-8 w-full rounded-[9px] bg-card pr-2.5 pl-8 text-[13px] ring-1 ring-input ring-inset placeholder:text-muted-foreground",
                    FOCUS,
                    SQUIRCLE,
                  )}
                />
              </label>
            )}
          </div>
        )}

        <div className="grid gap-6 @min-[760px]:grid-cols-[180px_minmax(0,1fr)] @min-[760px]:gap-10">
          {sections.length > 0 && (
            <nav
              aria-label="Settings sections"
              className="min-w-0 @min-[760px]:sticky @min-[760px]:top-4 @min-[760px]:self-start"
            >
              <ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 pb-1 @min-[760px]:flex-col @min-[760px]:overflow-visible @min-[760px]:pb-0">
                {sections.map((s) => {
                  const on = s.id === active;
                  return (
                    <li key={s.id} className="shrink-0">
                      <button
                        type="button"
                        aria-current={on ? "true" : undefined}
                        onClick={() => jump(s.id)}
                        className={cn(
                          "flex w-full cursor-pointer items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[13px] whitespace-nowrap transition-colors [&_svg]:size-4",
                          on
                            ? "bg-accent font-medium text-foreground"
                            : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                          FOCUS,
                          SQUIRCLE,
                        )}
                      >
                        {s.icon && <span aria-hidden>{s.icon}</span>}
                        {s.title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </nav>
          )}

          <div ref={body} className="flex min-w-0 flex-col gap-6">
            {children}
            {empty && (
              <p
                role="status"
                className="m-0 rounded-[12px] border border-dashed border-border px-4 py-8 text-center text-[13px] text-muted-foreground"
              >
                No settings match “{query}”.
              </p>
            )}
          </div>
        </div>

        <AnimatePresence>
          {(dirty || saved || error) && (
            <motion.div
              initial={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduce ? { opacity: 0 } : { opacity: 0, y: 12 }}
              transition={SOFT}
              className="sticky bottom-3 z-10 mt-6"
            >
              <div
                role="region"
                aria-label="Unsaved changes"
                className={cn(
                  "flex flex-wrap items-center gap-2 rounded-[12px] bg-card px-3.5 py-2.5 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.25)] ring-1 ring-border",
                  error && "ring-destructive/40",
                  SQUIRCLE,
                )}
              >
                <p
                  role="status"
                  className={cn(
                    "m-0 min-w-0 flex-1 text-[13px]",
                    error
                      ? "text-destructive"
                      : saved && !dirty
                        ? "text-success"
                        : "text-foreground",
                  )}
                >
                  {error ??
                    (saved && !dirty
                      ? "Changes saved."
                      : "You have unsaved changes.")}
                </p>
                {dirty && (
                  <>
                    {onDiscard && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          onDiscard();
                        }}
                        disabled={saving}
                      >
                        Discard
                      </Button>
                    )}
                    {onSave && (
                      <Button size="sm" onClick={save} loading={saving}>
                        {error ? "Try again" : saveLabel}
                      </Button>
                    )}
                  </>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}

export interface SettingsSectionProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  "title"
> {
  id: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** `danger` frames it in red, for delete and transfer. */
  tone?: "default" | "danger";
}

export function SettingsSection({
  id,
  title,
  description,
  tone = "default",
  className,
  children,
  ...props
}: SettingsSectionProps) {
  const hid = `settings-${id}-h`;
  return (
    <section
      id={`settings-${id}`}
      data-settings-section
      aria-labelledby={hid}
      className={cn(
        "scroll-mt-4 [[data-settings-searching]_&:not(:has([data-settings-row]:not([hidden])))]:hidden",
        className,
      )}
      {...props}
    >
      <h2
        id={hid}
        className={cn(
          "m-0 text-[14px] font-semibold",
          tone === "danger" && "text-destructive",
        )}
      >
        {title}
      </h2>
      {description && (
        <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">
          {description}
        </p>
      )}
      <div
        className={cn(
          "mt-3 divide-y divide-border rounded-[20px] bg-card ring-1 ring-inset",
          tone === "danger" ? "ring-destructive/35" : "ring-border",
          SQUIRCLE,
        )}
      >
        {children}
      </div>
    </section>
  );
}

export interface SettingsRowProps extends Omit<
  React.HTMLAttributes<HTMLDivElement>,
  "children"
> {
  label: string;
  description?: React.ReactNode;
  /** The control's id, so the label points at it. */
  htmlFor?: string;
  /** Extra words the search should find this row by. */
  keywords?: string[];
  /** The control: an input, a switch, a select, a button. */
  children: React.ReactNode;
}

export function SettingsRow({
  label,
  description,
  htmlFor,
  keywords = [],
  className,
  children,
  ...props
}: SettingsRowProps) {
  const { query } = React.useContext(Ctx);
  const text = [
    label,
    typeof description === "string" ? description : "",
    ...keywords,
  ]
    .join(" ")
    .toLowerCase();
  const hidden = Boolean(query) && !text.includes(query);
  return (
    <div
      data-settings-row
      hidden={hidden}
      className={cn(
        "flex flex-col gap-2.5 px-4 py-3.5 @min-[560px]:flex-row @min-[560px]:items-center @min-[560px]:justify-between @min-[560px]:gap-6",
        className,
      )}
      {...props}
    >
      <div className="min-w-0">
        {htmlFor ? (
          <label htmlFor={htmlFor} className="text-[13.5px] font-medium">
            {label}
          </label>
        ) : (
          <p className="m-0 text-[13.5px] font-medium">{label}</p>
        )}
        {description && (
          <p className="m-0 mt-0.5 text-[12.5px] text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 @min-[560px]:max-w-[55%] @min-[560px]:justify-end">
        {children}
      </div>
    </div>
  );
}

export default SettingsPage;
