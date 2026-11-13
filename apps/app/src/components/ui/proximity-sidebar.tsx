import { useCallback, useEffect, useRef } from "react";
import {
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  type MotionValue,
} from "motion/react";

type Section = { id: string; label: string; role?: "user" | "assistant" };

function Dash({
  section,
  active,
  mouseY,
  registerDash,
  onSelect,
}: {
  section: Section;
  active: boolean;
  mouseY: MotionValue<number>;
  registerDash: (id: string, node: HTMLButtonElement | null) => void;
  onSelect: (id: string) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const reducedMotion = useReducedMotion();
  const base = section.role === "assistant" ? 24 : 40;
  const bump = section.role === "assistant" ? 50 : 70;
  useEffect(() => {
    registerDash(section.id, ref.current);
    return () => registerDash(section.id, null);
  }, [registerDash, section.id]);
  const distance = useTransform(mouseY, (y) => {
    const rect = ref.current?.getBoundingClientRect();
    return rect ? y - (rect.top + rect.height / 2) : 40;
  });
  const targetScaleX = useTransform(
    distance,
    [-40, 0, 40],
    [base / 110, (base + bump) / 110, base / 110],
    { clamp: true },
  );
  const scaleX = useSpring(targetScaleX, {
    stiffness: 320,
    damping: 34,
    mass: 0.7,
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-current={active ? "location" : undefined}
      aria-label={`Jump to ${section.label}`}
      title={section.label}
      className="group flex h-px w-[110px] items-center border-0 bg-transparent p-0 outline-none"
      onClick={() => onSelect(section.id)}
    >
      <motion.span
        className={
          section.role === "assistant"
            ? "block bg-foreground/60 dark:bg-muted-foreground/40 group-focus-visible:ring-2 group-focus-visible:ring-ring"
            : "block bg-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring"
        }
        style={{
          height: 1,
          scaleX: reducedMotion ? targetScaleX : scaleX,
          transformOrigin: "right center",
          width: 110,
        }}
      />
    </button>
  );
}

export function ProximitySidebar({
  items,
  activeId,
  onSelect,
}: {
  items: readonly Section[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const mouseY = useMotionValue(Infinity);
  const dashRefs = useRef(new Map<string, HTMLButtonElement>());
  const pointerInside = useRef(false);
  const registerDash = useCallback(
    (id: string, node: HTMLButtonElement | null) => {
      if (node) dashRefs.current.set(id, node);
      else dashRefs.current.delete(id);
    },
    [],
  );
  useEffect(() => {
    if (pointerInside.current || !activeId) return;
    const rect = dashRefs.current.get(activeId)?.getBoundingClientRect();
    if (!rect) return;
    mouseY.set(rect.top + rect.height / 2);
    const timer = window.setTimeout(() => {
      if (!pointerInside.current) mouseY.set(Infinity);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [activeId, mouseY]);
  return (
    <nav
      aria-label="Message shortcuts"
      className="flex h-full min-h-0 items-center justify-end"
    >
      <div
        data-message-shortcuts=""
        className="flex flex-col items-end"
        style={{ gap: 8 }}
        onPointerMove={(event) => {
          pointerInside.current = true;
          mouseY.set(event.clientY);
        }}
        onPointerLeave={() => {
          pointerInside.current = false;
          mouseY.set(Infinity);
        }}
      >
        {items.map((section) => (
          <Dash
            key={section.id}
            section={section}
            active={section.id === activeId}
            mouseY={mouseY}
            registerDash={registerDash}
            onSelect={onSelect}
          />
        ))}
      </div>
    </nav>
  );
}
