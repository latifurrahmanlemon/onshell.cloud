"use client";

import { useEffect } from "react";
import "./table-preferences.css";

type Preferences = { widths: Record<string, number>; hidden: string[] };
const selector = "table > thead > tr, .table-head, .data-grid-row.is-head";
const clamp = (width: number) => Math.max(64, Math.min(1000, Math.round(width)));

/** Progressive enhancement for both native tables and the console's CSS grids.
 * Only layout and isolated controls are owned here; React continues to own rows.
 */
export function useTablePreferences(scope: string) {
  useEffect(() => {
    const installed = new Map<HTMLElement, { signature: string; update: () => void; dispose: () => void }>();
    const signature = (head: HTMLElement) => Array.from(head.children).map(cell => cell.textContent?.trim()).join("|");
    let frame = 0;
    function install(head: HTMLElement) {
      const native = head.tagName === "TR";
      const table = native ? head.closest("table")! : head.parentElement!;
      const cells = Array.from(head.children) as HTMLElement[];
      if (cells.length < 2) return;
      const labels = cells.map((cell, i) => (cell.dataset.column ?? cell.textContent?.trim()) || (cell.querySelector('input[type="checkbox"]') ? "Selection" : i === cells.length - 1 ? "Actions" : `Column ${i + 1}`));
      const keys = labels.map((label, i) => `${label}:${i}`);
      const key = `onshell:table:v1:${scope}:${table.dataset.tableId ?? labels.join("|")}`;
      const defaults = cells.flatMap((cell, i) => cell.dataset.defaultHidden === "true" ? [keys[i]] : []);
      let prefs: Preferences = { widths: {}, hidden: defaults };
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? "null");
        if (saved && typeof saved === "object") prefs = {
          widths: Object.fromEntries(Object.entries(saved.widths ?? {}).filter(([k, v]) => keys.includes(k) && typeof v === "number" && Number.isFinite(v)).map(([k, v]) => [k, clamp(v as number)])),
          hidden: Array.isArray(saved.hidden) ? saved.hidden.filter((k: unknown) => typeof k === "string" && keys.includes(k)) : defaults,
        };
      } catch { /* Storage can be disabled or contain preferences from an older version. */ }
      if (prefs.hidden.length >= cells.length) prefs.hidden = [];
      const base = cells.map(cell => Math.max(100, Math.min(360, cell.getBoundingClientRect().width || 160)));
      const toolbar = document.createElement("div");
      toolbar.className = "table-preferences";
      toolbar.dataset.tableControls = "true";
      const menu = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Columns";
      const choices = document.createElement("div"); choices.className = "table-column-choices";
      menu.addEventListener("toggle", () => {
        if (!menu.open) return;
        const rect = summary.getBoundingClientRect();
        choices.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 248))}px`;
        choices.style.top = `${rect.bottom + 4}px`;
        choices.style.maxHeight = `${Math.max(100, Math.min(360, window.innerHeight - rect.bottom - 16))}px`;
      });
      menu.append(summary, choices);
      const reset = document.createElement("button"); reset.type = "button"; reset.textContent = "Reset table";
      const hint = document.createElement("span"); hint.textContent = "Drag column edges to resize";
      toolbar.append(menu, reset, hint);
      const search = document.createElement("input"); search.type = "search";
      search.placeholder = "Search displayed rows"; search.setAttribute("aria-label", "Search displayed rows");
      if (native) toolbar.insertBefore(search, hint);
      table.before(toolbar);
      table.classList.add("resizable-table");
      const scroll = native ? table.parentElement! : table;
      scroll.classList.add("resizable-table-scroll");
      const handles: HTMLElement[] = [];
      const checkboxes: HTMLInputElement[] = [];
      const save = () => { try { localStorage.setItem(key, JSON.stringify(prefs)); } catch { /* Keep working without storage. */ } };
      let endDrag: (() => void) | undefined;
      const rows = () => native ? Array.from((table as HTMLTableElement).rows) : Array.from(table.children).filter(row => row !== toolbar && row.classList.contains(head.classList[0]));
      const apply = () => {
        const widths = keys.map((k, i) => prefs.widths[k] ?? base[i]);
        const total = widths.reduce((sum, width, i) => sum + (prefs.hidden.includes(keys[i]) ? 0 : width), 0);
        if (native) { table.style.tableLayout = "fixed"; table.style.width = `${total}px`; table.style.minWidth = `${total}px`; }
        const currentRows = rows();
        let visibleRows = 0;
        for (const row of currentRows) {
          if (row !== head) {
            const matches = !native || !search.value.trim() || row.textContent?.toLowerCase().includes(search.value.trim().toLowerCase());
            row.classList.toggle("table-row-filtered", !matches);
            if (matches) visibleRows++;
          }
          const rowCells = Array.from(row.children) as HTMLElement[];
          if (rowCells.length !== cells.length) continue; // Preserve expanded-detail and empty-state rows.
          if (!native) {
            const style = (row as HTMLElement).style;
            style.setProperty("display", "grid", "important");
            style.setProperty("grid-template-columns", keys.filter(k => !prefs.hidden.includes(k)).map(k => `${widths[keys.indexOf(k)]}px`).join(" "), "important");
            style.width = "max-content"; style.minWidth = "100%";
          }
          rowCells.forEach((cell, i) => {
            cell.classList.toggle("table-column-hidden", prefs.hidden.includes(keys[i]));
            if (native) { cell.style.width = `${widths[i]}px`; cell.style.maxWidth = `${widths[i]}px`; }
          });
        }
        handles.forEach((handle, i) => {
          if (!cells[i].contains(handle)) cells[i].append(handle);
          handle.setAttribute("aria-valuenow", String(Math.round(widths[i])));
        });
        checkboxes.forEach((input, i) => { input.checked = !prefs.hidden.includes(keys[i]); input.disabled = input.checked && prefs.hidden.length === cells.length - 1; });
        summary.textContent = `Columns (${cells.length - prefs.hidden.length}/${cells.length})`;
        hint.textContent = `${visibleRows} displayed rows · Drag column edges to resize`;
      };
      search.addEventListener("input", apply);
      cells.forEach((cell, i) => {
        const label = document.createElement("label");
        const input = document.createElement("input"); input.type = "checkbox";
        input.addEventListener("change", () => { prefs.hidden = input.checked ? prefs.hidden.filter(k => k !== keys[i]) : [...prefs.hidden, keys[i]]; apply(); save(); });
        label.append(input, document.createTextNode(labels[i])); choices.append(label); checkboxes.push(input);
        const handle = document.createElement("span"); handle.className = "table-resize-handle";
        handle.tabIndex = 0; handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-label", `Resize ${labels[i]} column`); handle.setAttribute("aria-valuemin", "64"); handle.setAttribute("aria-valuemax", "1000");
        handle.title = "Drag to resize. Arrow keys adjust width; Home resets this column.";
        handle.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
        handle.addEventListener("keydown", event => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Home") delete prefs.widths[keys[i]];
          else prefs.widths[keys[i]] = clamp((prefs.widths[keys[i]] ?? base[i]) + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 10));
          apply(); save();
        });
        handle.addEventListener("pointerdown", event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation(); endDrag?.();
          const x = event.clientX, width = prefs.widths[keys[i]] ?? base[i];
          let resizeFrame = 0;
          const move = (next: PointerEvent) => {
            prefs.widths[keys[i]] = clamp(width + next.clientX - x);
            if (!resizeFrame) resizeFrame = requestAnimationFrame(() => { resizeFrame = 0; apply(); });
          };
          const finish = () => {
            cancelAnimationFrame(resizeFrame); apply(); save();
            window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", finish); window.removeEventListener("pointercancel", finish);
            document.body.classList.remove("table-resizing"); endDrag = undefined;
          };
          endDrag = finish; document.body.classList.add("table-resizing");
          window.addEventListener("pointermove", move); window.addEventListener("pointerup", finish); window.addEventListener("pointercancel", finish);
        });
        cell.classList.add("table-resizable-heading"); cell.append(handle); handles.push(handle);
      });
      reset.addEventListener("click", () => { prefs = { widths: {}, hidden: [...defaults] }; apply(); save(); menu.open = false; });
      const dismiss = (event: Event) => { if (!menu.contains(event.target as Node)) menu.open = false; };
      const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && menu.open) { menu.open = false; summary.focus(); } };
      document.addEventListener("pointerdown", dismiss); document.addEventListener("keydown", escape);
      apply();
      installed.set(head, { signature: signature(head), update: apply, dispose: () => {
        endDrag?.(); toolbar.remove(); handles.forEach(handle => handle.remove());
        document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape);
      } });
    }
    const scan = () => {
      frame = 0;
      for (const [head, item] of installed) { if (!head.isConnected || item.signature !== signature(head)) { item.dispose(); installed.delete(head); } else item.update(); }
      document.querySelectorAll<HTMLElement>(selector).forEach(head => { if (!installed.has(head)) install(head); });
    };
    const observer = new MutationObserver(records => {
      if (records.every(record => (record.target as Element).closest?.(".table-preferences, .table-resize-handle"))) return;
      const relevant = records.some(record => {
        if ((record.target as Element).closest?.(".resizable-table")) return true;
        return [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node instanceof Element && (node.matches(selector) || node.querySelector(selector)));
      });
      if (!relevant) return;
      if (!frame) frame = requestAnimationFrame(scan);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); installed.forEach(item => item.dispose()); };
  }, [scope]);
}
