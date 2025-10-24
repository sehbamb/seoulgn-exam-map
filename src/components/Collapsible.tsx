import { useState, useId } from "react";

export function Collapsible({
  title,
  defaultOpen = true,
  children,
}: {
  title: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <section
      aria-labelledby={id}
      style={{
        borderTop: "1px solid #eee",
        padding: "8px 0",
      }}
    >
      <header
        id={id}
        onClick={() => setOpen((o) => !o)}
        role="button"
        aria-expanded={open}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <strong>{title}</strong>
        <span
          style={{
            transform: `rotate(${open ? 90 : 0}deg)`,
            transition: "transform .15s",
          }}
        >
          ›
        </span>
      </header>

      {open && <div style={{ marginTop: 8 }}>{children}</div>}
    </section>
  );
}
