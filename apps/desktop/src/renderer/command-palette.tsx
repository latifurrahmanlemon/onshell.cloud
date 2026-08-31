import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "./icons.js";

export interface CommandAction {
  id: string;
  label: string;
  detail?: string;
  icon: IconName;
  keywords?: string;
  run(): void;
}

interface Props {
  actions: CommandAction[];
  onClose(): void;
}

export function CommandPalette({ actions, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return actions.slice(0, 12);
    return actions
      .filter((action) =>
        `${action.label} ${action.detail ?? ""} ${action.keywords ?? ""}`.toLowerCase().includes(needle)
      )
      .slice(0, 12);
  }, [actions, query]);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setSelected(0), [query]);

  function choose(index: number) {
    const action = visible[index];
    if (!action) return;
    onClose();
    action.run();
  }

  return (
    <div className="palette-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="palette"
        aria-label="Command palette"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette__search">
          <Icon name="search" size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((current) => Math.min(current + 1, visible.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((current) => Math.max(current - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                choose(selected);
              }
            }}
            placeholder="Search hosts, snippets, files and actions…"
            aria-label="Search commands"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette__list" role="listbox">
          {visible.map((action, index) => (
            <button
              key={action.id}
              className={`palette__item${index === selected ? " palette__item--selected" : ""}`}
              role="option"
              aria-selected={index === selected}
              onMouseEnter={() => setSelected(index)}
              onClick={() => choose(index)}
            >
              <span className="palette__icon">
                <Icon name={action.icon} size={16} />
              </span>
              <span>
                <strong>{action.label}</strong>
                {action.detail && <small>{action.detail}</small>}
              </span>
            </button>
          ))}
          {visible.length === 0 && <div className="palette__empty">No command matches “{query}”.</div>}
        </div>
        <footer className="palette__footer">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>Enter</kbd> Open
          </span>
        </footer>
      </section>
    </div>
  );
}
