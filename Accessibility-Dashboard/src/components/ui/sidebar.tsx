import { cn } from "@/lib/utils";
import { motion } from "framer-motion";
import React, { createContext, useContext } from "react";

export interface SidebarItem {
  label: string;
  href?: string;
  icon: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
}

interface SidebarContextProps {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  animate: boolean;
}

const SidebarContext = createContext<SidebarContextProps | undefined>(undefined);

export function useSidebar() {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
}

export function SidebarProvider({
  children,
  open: openProp = true,
  setOpen: setOpenProp,
  animate = false
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) {
  // Permanent sidebar: always treated as open. setOpen is a no-op unless a
  // controlled setter is provided (kept for API compatibility).
  const open = openProp;
  const setOpen = setOpenProp ?? (() => undefined);

  return <SidebarContext.Provider value={{ open, setOpen, animate }}>{children}</SidebarContext.Provider>;
}

export function Sidebar({
  children,
  open = true,
  setOpen,
  animate = false
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) {
  return (
    <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
      {children}
    </SidebarProvider>
  );
}

export function SidebarBody(props: React.ComponentProps<typeof motion.div>) {
  return <DesktopSidebar {...props} />;
}

export function DesktopSidebar({
  className,
  children,
  ...props
}: React.ComponentProps<typeof motion.div>) {
  return (
    <motion.aside
      className={cn(
        "dashboard-drawer dashboard-sidebar z-20 flex shrink-0 flex-col overflow-hidden border-b md:border-b-0 md:border-r",
        className
      )}
      initial={false}
      style={{ backfaceVisibility: "hidden", contain: "layout paint style" }}
      {...props}
    >
      {children}
    </motion.aside>
  );
}

/** @deprecated Mobile overlay removed — permanent sidebar is shared across breakpoints. */
export function MobileSidebar({
  className,
  children
}: React.ComponentProps<"div">) {
  return (
    <div className={cn("dashboard-drawer flex w-full flex-col p-4", className)}>
      {children}
    </div>
  );
}

export function SidebarLink({
  link,
  className,
  ...props
}: {
  link: SidebarItem;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick">) {
  const textNode = (
    <span className="overflow-hidden whitespace-nowrap text-sm font-medium text-current transition-colors">
      {link.label}
    </span>
  );

  const baseClass = cn(
    "sidebar-nav-link reference-sidebar-row reference-sidebar-primary-row group flex w-full items-center rounded-[var(--dashboard-sidebar-item-radius)] border text-left transition focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-[var(--dashboard-accent)]",
    link.active
      ? "sidebar-nav-link-active border-transparent bg-transparent text-slate-900"
      : "border-transparent bg-transparent text-[var(--dashboard-sidebar-muted-text)] hover:border-[var(--dashboard-sidebar-item-hover-border)] hover:bg-[var(--dashboard-sidebar-item-hover-bg)] hover:text-[var(--dashboard-sidebar-hover-text)]",
    className
  );

  if (link.onClick) {
    return (
      <button
        type="button"
        className={baseClass}
        onClick={() => link.onClick?.()}
        {...props}
        aria-current={link.active ? "page" : undefined}
      >
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-current">{link.icon}</span>
        {textNode}
      </button>
    );
  }

  return (
    <a href={link.href ?? "#"} className={baseClass} aria-current={link.active ? "page" : undefined}>
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-current">{link.icon}</span>
      {textNode}
    </a>
  );
}
