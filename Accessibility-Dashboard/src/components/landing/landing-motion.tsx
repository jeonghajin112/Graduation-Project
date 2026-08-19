import { createContext, useContext, type ReactNode } from "react";
import { motion, useReducedMotion } from "framer-motion";

/**
 * Motion rules for the landing page.
 *
 * - entry: short opacity fade plus a 12–24px offset, nothing else;
 * - every scroll-triggered reveal runs once;
 * - UI transitions (tabs, media swaps) stay inside 160–300ms;
 * - with `prefers-reduced-motion` the initial state is the final state, so no
 *   copy is ever withheld behind an animation.
 */
export const ENTRY_EASE = [0.22, 1, 0.36, 1] as const;
export const ENTRY_DURATION = 0.5;
export const SWAP_DURATION = 0.2;

const ReducedMotionContext = createContext(false);

export function useLandingReducedMotion() {
  return useContext(ReducedMotionContext);
}

export function LandingMotionProvider({ children }: { children: ReactNode }) {
  const reduce = Boolean(useReducedMotion());
  return <ReducedMotionContext.Provider value={reduce}>{children}</ReducedMotionContext.Provider>;
}

const MOTION_TAGS = {
  div: motion.div,
  section: motion.section,
  article: motion.article,
  figure: motion.figure,
  header: motion.header,
  ol: motion.ol,
  ul: motion.ul,
  li: motion.li,
  p: motion.p,
} as const;

type MotionTag = keyof typeof MOTION_TAGS;

type RevealProps = {
  children: ReactNode;
  as?: MotionTag;
  className?: string;
  /** Vertical entry offset in px. Kept between 12 and 24 by design. */
  distance?: number;
  delay?: number;
  id?: string;
  /** Animate on mount instead of on scroll — used for above-the-fold copy. */
  immediate?: boolean;
};

export function Reveal({
  children,
  as = "div",
  className,
  distance = 18,
  delay = 0,
  id,
  immediate = false,
}: RevealProps) {
  const reduce = useLandingReducedMotion();
  const Component = MOTION_TAGS[as];

  const transition = {
    duration: reduce ? 0 : ENTRY_DURATION,
    delay: reduce ? 0 : delay,
    ease: ENTRY_EASE,
  };

  if (reduce) {
    return (
      <Component id={id} className={className}>
        {children}
      </Component>
    );
  }

  if (immediate) {
    return (
      <Component
        id={id}
        className={className}
        initial={{ opacity: 0, y: distance }}
        animate={{ opacity: 1, y: 0 }}
        transition={transition}
      >
        {children}
      </Component>
    );
  }

  return (
    <Component
      id={id}
      className={className}
      initial={{ opacity: 0, y: distance }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-64px" }}
      transition={transition}
    >
      {children}
    </Component>
  );
}
