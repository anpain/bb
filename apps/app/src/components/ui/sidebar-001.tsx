import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  AnimatePresence,
  LayoutGroup,
  motion,
  useReducedMotion,
} from "motion/react";
import { cn } from "@bb/shared-ui/lib/utils";

interface HoverRect {
  top: number;
  height: number;
  left: number;
}
const HoverContext = createContext<{
  hovered: string | null;
  container: HTMLDivElement | null;
  setHovered: (id: string | null, rect?: HoverRect) => void;
}>({ hovered: null, container: null, setHovered: () => {} });

export function Sidebar001({ children }: { children: ReactNode }) {
  const id = useId();
  const reduced = useReducedMotion();
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [hovered, setHoveredId] = useState<string | null>(null);
  const [rect, setRect] = useState<HoverRect | null>(null);
  return (
    <LayoutGroup id={id}>
      <HoverContext.Provider
        value={{
          hovered,
          container,
          setHovered: (next, bounds) => {
            setHoveredId(next);
            setRect(bounds ?? null);
          },
        }}
      >
        <div ref={setContainer} className="relative px-1">
          <AnimatePresence>
            {hovered && rect ? (
              <motion.div
                key="sb001-hover-bg"
                className="pointer-events-none absolute z-0 rounded-md bg-accent/50"
                style={{ right: 0 }}
                initial={false}
                animate={{
                  top: rect.top + 2,
                  height: rect.height - 4,
                  left: rect.left,
                  opacity: 1,
                }}
                exit={{ opacity: 0 }}
                transition={
                  reduced
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 300, damping: 30 }
                }
              />
            ) : null}
          </AnimatePresence>
          {children}
        </div>
      </HoverContext.Provider>
    </LayoutGroup>
  );
}

export function Sidebar001Item({
  id,
  label,
  active,
  pending,
  onSelect,
  register,
}: {
  id: string;
  label: ReactNode;
  active: boolean;
  pending: boolean;
  onSelect: () => void;
  register: (node: HTMLButtonElement | null) => void;
}) {
  const { hovered, setHovered, container } = useContext(HoverContext);
  const ref = useRef<HTMLButtonElement | null>(null);
  const reduced = useReducedMotion();
  const isHovered = hovered === id;
  const opacity = active ? 1 : hovered !== null ? (isHovered ? 1 : 0.3) : 0.55;
  const x = active ? 8 : isHovered ? 6 : 0;
  const transition = reduced
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 700, damping: 30 };
  const highlight = () => {
    if (!ref.current || !container) return;
    const bounds = ref.current.getBoundingClientRect();
    const parent = container.getBoundingClientRect();
    setHovered(id, {
      top: bounds.top - parent.top,
      height: bounds.height,
      left: 25,
    });
  };
  return (
    <div className="relative">
      {active ? (
        <motion.span
          layoutId="sb001-active-bar"
          className="pointer-events-none absolute left-1 top-1/2 z-10 h-[1.8px] -translate-y-1/2 rounded-full bg-foreground"
          animate={{ width: 23 }}
          transition={
            reduced
              ? { duration: 0 }
              : { type: "spring", stiffness: 800, damping: 40 }
          }
        />
      ) : null}
      <motion.span
        className="pointer-events-none absolute left-0 top-1/2 h-px -translate-y-1/2 bg-foreground/50"
        animate={{ width: active ? 0 : isHovered ? 26 : 18 }}
        transition={transition}
      />
      <span className="pointer-events-none absolute left-0 top-1/4 h-px w-[13px] bg-foreground/30" />
      <span className="pointer-events-none absolute left-0 top-0 h-px w-4 bg-foreground/30" />
      <span className="pointer-events-none absolute left-0 top-3/4 h-px w-[13px] bg-foreground/30" />
      <motion.div
        animate={{ opacity, x }}
        transition={transition}
        style={{ transformOrigin: "left center" }}
      >
        <button
          ref={(node) => {
            ref.current = node;
            register(node);
          }}
          type="button"
          aria-current={active ? "location" : undefined}
          aria-busy={pending}
          onClick={onSelect}
          onMouseEnter={highlight}
          onMouseLeave={() => setHovered(null)}
          onFocus={highlight}
          onBlur={() => setHovered(null)}
          className={cn(
            "relative ml-2 flex w-[calc(100%-0.5rem)] select-none items-center gap-2 py-1.5 pl-4 text-left text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            pending && "animate-pulse",
          )}
        >
          <span className="relative z-1 min-w-0 truncate">{label}</span>
        </button>
      </motion.div>
    </div>
  );
}
