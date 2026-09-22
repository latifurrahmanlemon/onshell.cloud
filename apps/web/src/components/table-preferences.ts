"use client";

import { useEffect } from "react";
import "./table-preferences.css";

type Preferences = { widths: Record<string, number>; hidden: string[] };
const selector = "table > thead > tr, .table-head, .data-grid-row.is-head";
const clamp = (width: number) => Math.max(64, Math.min(1000, Math.round(width)));
function controlIcon(paths: string[]) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  Object.entries({ viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.7", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }).forEach(([key, value]) => svg.setAttribute(key, value));
  paths.forEach(d => { const path = document.createElementNS(svg.namespaceURI, "path"); path.setAttribute("d", d); svg.append(path); });
  return svg;
}

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
      const actionIndex = labels.findIndex(label => /^(actions?|details)$/i.test(label));
      if (actionIndex >= 0 && !cells[actionIndex].textContent?.trim()) cells[actionIndex].textContent = "Actions";
      const ordered = keys.map((_, i) => i).filter(i => i !== actionIndex).concat(actionIndex < 0 ? [] : [actionIndex]);
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
      prefs.hidden = prefs.hidden.filter(key => key !== keys[actionIndex]);
      const base = cells.map(cell => Math.max(100, Math.min(360, cell.getBoundingClientRect().width || 160)));
      const toolbar = document.createElement("div");
      toolbar.className = "table-preferences";
      toolbar.dataset.tableControls = "true";
      const menu = document.createElement("details");
      const summary = document.createElement("summary");
      summary.setAttribute("aria-label", "Choose columns"); summary.title = "Choose columns";
      summary.append(controlIcon(["M4 4h16v16H4z", "M10 4v16M16 4v16"]));
      const choices = document.createElement("div"); choices.className = "table-column-choices";
      menu.addEventListener("toggle", () => {
        if (!menu.open) return;
        const rect = summary.getBoundingClientRect();
        choices.style.left = `${Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248))}px`;
        choices.style.top = `${rect.bottom + 4}px`;
        choices.style.maxHeight = `${Math.max(100, Math.min(360, window.innerHeight - rect.bottom - 16))}px`;
      });
      menu.append(summary, choices);
      const reset = document.createElement("button"); reset.type = "button";
      reset.setAttribute("aria-label", "Reset table"); reset.title = "Reset table";
      reset.append(controlIcon(["M3 10a9 9 0 1 1 2 8", "M3 4v6h6"]));
      const hint = document.createElement("span"); hint.textContent = "Drag column edges to resize";
      toolbar.append(hint, menu, reset);
      const search = document.createElement("input"); search.type = "search";
      search.placeholder = "Search displayed rows"; search.setAttribute("aria-label", "Search displayed rows");
      if (native) toolbar.prepend(search);
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
        const widths = keys.map((k, i) => labels[i] === "Selection" ? 44 : i === actionIndex ? Math.max(96, Math.min(160, prefs.widths[k] ?? base[i])) : prefs.widths[k] ?? base[i]);
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
            style.setProperty("grid-template-columns", ordered.filter(i => !prefs.hidden.includes(keys[i])).map(i => `${widths[i]}px`).join(" "), "important");
            style.width = "max-content"; style.minWidth = "100%";
            style.paddingRight = "0";
          }
          rowCells.forEach((cell, i) => {
            cell.classList.toggle("table-column-hidden", prefs.hidden.includes(keys[i]));
            cell.classList.toggle("table-actions-pinned", i === actionIndex);
            if (!native) {
              cell.style.order = String(i === actionIndex ? cells.length : i);
              cell.style.setProperty("grid-column", "auto", "important");
              cell.style.setProperty("grid-row", "auto", "important");
            }
            if (native) { cell.style.width = `${widths[i]}px`; cell.style.maxWidth = `${widths[i]}px`; }
          });
        }
        handles.forEach((handle, i) => {
          if (!cells[i].contains(handle)) cells[i].append(handle);
          handle.setAttribute("aria-valuenow", String(Math.round(widths[i])));
        });
        checkboxes.forEach((input, i) => { input.checked = !prefs.hidden.includes(keys[i]); input.disabled = i === actionIndex || (input.checked && prefs.hidden.length === cells.length - 1); });
        summary.title = `Choose columns (${cells.length - prefs.hidden.length}/${cells.length} visible)`;
        hint.textContent = `${visibleRows} rows`;
      };
      search.addEventListener("input", apply);
      cells.forEach((cell, i) => {
        const label = document.createElement("label");
        const input = document.createElement("input"); input.type = "checkbox";
        input.addEventListener("change", () => { prefs.hidden = input.checked ? prefs.hidden.filter(k => k !== keys[i]) : [...prefs.hidden, keys[i]]; apply(); save(); });
        label.append(input, document.createTextNode(labels[i])); choices.append(label); checkboxes.push(input);
        const handle = document.createElement("span"); handle.className = "table-resize-handle";
        handle.hidden = labels[i] === "Selection";
        const resizeWidth = (width: number) => i === actionIndex ? Math.max(96, Math.min(160, Math.round(width))) : clamp(width);
        handle.tabIndex = 0; handle.setAttribute("role", "separator"); handle.setAttribute("aria-orientation", "vertical");
        handle.setAttribute("aria-label", `Resize ${labels[i]} column`); handle.setAttribute("aria-valuemin", i === actionIndex ? "96" : "64"); handle.setAttribute("aria-valuemax", i === actionIndex ? "160" : "1000");
        handle.title = "Drag to resize. Arrow keys adjust width; Home resets this column.";
        handle.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); });
        handle.addEventListener("keydown", event => {
          if (!["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          if (event.key === "Home") delete prefs.widths[keys[i]];
          else prefs.widths[keys[i]] = resizeWidth(Number(handle.getAttribute("aria-valuenow")) + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 10));
          apply(); save();
        });
        handle.addEventListener("pointerdown", event => {
          if (event.button !== 0) return;
          event.preventDefault(); event.stopPropagation(); endDrag?.();
          const x = event.clientX, width = Number(handle.getAttribute("aria-valuenow"));
          let resizeFrame = 0;
          const move = (next: PointerEvent) => {
            prefs.widths[keys[i]] = resizeWidth(width + next.clientX - x);
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
