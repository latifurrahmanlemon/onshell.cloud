"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  Upload
} from "lucide-react";
import { cx } from "@onshell/ui";
import {
  consoleApi,
  type HostExportFormat,
  type HostImportFormat,
  type HostImportPreview,
  type HostImportResult
} from "./api";

/** Formats the operator can force when auto-detection guesses wrong. */
const FORMAT_OPTIONS: Array<{ value: HostImportFormat | "auto"; label: string }> = [
  { value: "auto", label: "Detect automatically" },
  { value: "onshell-json", label: "Onshell.cloud JSON" },
  { value: "termius-json", label: "Termius JSON" },
  { value: "csv", label: "CSV / Termius CSV" },
  { value: "ssh-config", label: "OpenSSH config (~/.ssh/config)" },
  { value: "putty-reg", label: "PuTTY registry export (.reg)" },
  { value: "rdp", label: "Windows Remote Desktop (.rdp)" },
  { value: "rdcman", label: "Remote Desktop Connection Manager (.rdg)" }
];

const FORMAT_LABELS: Record<HostImportFormat, string> = {
  "onshell-json": "Onshell.cloud JSON",
  "termius-json": "Termius JSON",
  csv: "CSV",
  "ssh-config": "OpenSSH config",
  "putty-reg": "PuTTY registry export",
  rdp: "Windows Remote Desktop",
  rdcman: "RDCMan"
};

const EXPORT_OPTIONS: Array<{ value: HostExportFormat; label: string; hint: string }> = [
  { value: "json", label: "JSON", hint: "Re-importable into Onshell. Keeps groups, tags, and notes." },
  { value: "csv", label: "CSV", hint: "Opens in Excel or Sheets. Also imports into Termius." },
  { value: "ssh-config", label: "OpenSSH config", hint: "Drop into ~/.ssh/config. SSH hosts only." }
];

/** 12MB matches the API's import body limit. */
const MAX_FILE_BYTES = 12 * 1024 * 1024;

function dispositionLabel(disposition: HostImportPreviewRow["disposition"]) {
  switch (disposition) {
    case "new":
      return { text: "Will import", tone: "ok" as const };
    case "exists":
      return { text: "Already exists", tone: "warn" as const };
    case "duplicate-in-file":
      return { text: "Duplicate in file", tone: "muted" as const };
  }
}

type HostImportPreviewRow = HostImportPreview["hosts"][number];

export function HostTransferPanel({
  onImported,
  notify
}: {
  onImported: () => void;
  notify: (message: string, kind?: "success" | "error") => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [content, setContent] = useState("");
  const [filename, setFilename] = useState<string | undefined>();
  const [format, setFormat] = useState<HostImportFormat | "auto">("auto");
  const [preview, setPreview] = useState<HostImportPreview | null>(null);
  const [result, setResult] = useState<HostImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [environmentOverride, setEnvironmentOverride] = useState<"" | "production" | "staging" | "development">("");
  const [groupOverride, setGroupOverride] = useState("");
  const [extraTags, setExtraTags] = useState("");
  const [onDuplicate, setOnDuplicate] = useState<"skip" | "update">("skip");

  function reset() {
    setContent("");
    setFilename(undefined);
    setFormat("auto");
    setPreview(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function onFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.size > MAX_FILE_BYTES) {
      setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)}MB. The limit is 12MB — split it and import in parts.`);
      return;
    }

    setError(null);
    setResult(null);
    setPreview(null);

    const text = await file.text();
    setContent(text);
    setFilename(file.name);
    // Run the dry run immediately: the operator picked a file, they do not also
    // want to press "Analyse".
    void analyse(text, file.name, format);
  }

  async function analyse(text: string, name: string | undefined, chosenFormat: HostImportFormat | "auto") {
    if (!text.trim()) {
      setError("Paste some content or choose a file first.");
      return;
    }

    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await consoleApi.previewHostImport({
        content: text,
        ...(name ? { filename: name } : {}),
        ...(chosenFormat === "auto" ? {} : { format: chosenFormat })
      });
      setPreview(response);
    } catch (caught) {
      setPreview(null);
      setError(
        caught instanceof Error && caught.message === "unrecognised_format"
          ? "Couldn't recognise this file. Pick the format manually from the dropdown."
          : caught instanceof Error
            ? caught.message
            : "Could not read that file."
      );
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview) return;

    setBusy(true);
    setError(null);
    try {
      const tags = extraTags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 12);

      const response = await consoleApi.importHosts({
        content,
        ...(filename ? { filename } : {}),
        ...(format === "auto" ? {} : { format }),
        ...(environmentOverride ? { environmentOverride } : {}),
        ...(groupOverride.trim() ? { groupOverride: groupOverride.trim() } : {}),
        ...(tags.length > 0 ? { extraTags: tags } : {}),
        onDuplicate
      });

      setResult(response);
      setPreview(null);
      notify(
        `Imported ${response.created} host${response.created === 1 ? "" : "s"}${response.updated ? `, updated ${response.updated}` : ""}.`,
        "success"
      );
      onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ht-stack">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Import hosts</h2>
            <p>
              Bring your estate over from Termius, PuTTY, an <code>~/.ssh/config</code>, Windows Remote Desktop, or
              RDCMan. Nothing is written until you review what was found.
            </p>
          </div>
        </div>

        <div className="ht-body">
          <div className="ht-source">
            <input
              accept=".json,.csv,.tsv,.txt,.config,.conf,.reg,.rdp,.rdg,.xml"
              className="sr-only"
              onChange={onFileChosen}
              ref={fileInputRef}
              type="file"
            />
            <button className="secondary-button" onClick={() => fileInputRef.current?.click()} type="button">
              <FileUp size={15} />
              Choose file
            </button>
            <span className="ht-filename">{filename ?? "No file chosen — or paste below"}</span>

            <label className="ht-format">
              <span>Format</span>
              <select
                onChange={(event) => {
                  const next = event.target.value as HostImportFormat | "auto";
                  setFormat(next);
                  // Re-analyse straight away so the preview matches the choice.
                  if (content.trim()) void analyse(content, filename, next);
                }}
                value={format}
              >
                {FORMAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="ht-paste">
            <span className="sr-only">Paste host list</span>
            <textarea
              onChange={(event) => {
                setContent(event.target.value);
                setPreview(null);
                setResult(null);
              }}
              placeholder={"Host bastion\n  HostName 10.0.0.1\n  Port 2222\n  User deploy"}
              rows={7}
              value={content}
            />
          </label>

          <div className="ht-actions">
            <button
              className="primary-button"
              disabled={busy || !content.trim()}
              onClick={() => void analyse(content, filename, format)}
              type="button"
            >
              {busy ? <Loader2 className="spin" size={15} /> : <ArrowRight size={15} />}
              Analyse
            </button>
            {(content || preview || result) && (
              <button className="secondary-button" disabled={busy} onClick={reset} type="button">
                Clear
              </button>
            )}
          </div>

          {error && (
            <p className="ht-error" role="alert">
              <AlertTriangle size={15} />
              {error}
            </p>
          )}

          {result && (
            <div className="ht-result" role="status">
              <p className="ht-result-title">
                <CheckCircle2 size={16} />
                Imported {result.created} host{result.created === 1 ? "" : "s"} from{" "}
                {FORMAT_LABELS[result.format]}
              </p>
              <ul>
                {result.updated > 0 && <li>{result.updated} existing host(s) updated.</li>}
                {result.skippedExisting > 0 && <li>{result.skippedExisting} already existed and were left alone.</li>}
                {result.duplicatesInFile > 0 && <li>{result.duplicatesInFile} duplicate row(s) inside the file.</li>}
                {result.failed > 0 && <li className="is-warn">{result.failed} row(s) could not be saved.</li>}
                {result.issues.length > 0 && <li>{result.issues.length} row(s) were skipped as unusable.</li>}
              </ul>
              {result.issues.length > 0 && (
                <details>
                  <summary>Show skipped rows</summary>
                  <ul className="ht-issues">
                    {result.issues.map((issue) => (
                      <li key={`${issue.sourceRef}-${issue.message}`}>
                        <code>{issue.sourceRef}</code> {issue.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}

          {preview && (
            <div className="ht-preview">
              <div className="ht-summary">
                <span className="ht-chip">{FORMAT_LABELS[preview.format]}</span>
                <span>
                  <strong>{preview.summary.new}</strong> to import
                </span>
                {preview.summary.existing > 0 && (
                  <span>
                    <strong>{preview.summary.existing}</strong> already exist
                  </span>
                )}
                {preview.summary.duplicatesInFile > 0 && (
                  <span>
                    <strong>{preview.summary.duplicatesInFile}</strong> duplicates in file
                  </span>
                )}
                {preview.summary.skipped > 0 && (
                  <span className="is-warn">
                    <strong>{preview.summary.skipped}</strong> unusable
                  </span>
                )}
              </div>

              {preview.limit.wouldExceed && (
                <p className="ht-error" role="alert">
                  <AlertTriangle size={15} />
                  This would put you over your {preview.limit.planName ?? "plan"} limit of {preview.limit.maxHosts}{" "}
                  hosts. You have {preview.limit.currentHosts} and can add {preview.limit.remaining} more.
                </p>
              )}

              {preview.summary.new > 0 && (
                <div className="ht-options">
                  <label>
                    Environment
                    <select
                      onChange={(event) => setEnvironmentOverride(event.target.value as typeof environmentOverride)}
                      value={environmentOverride}
                    >
                      <option value="">Keep what was detected</option>
                      <option value="production">Set all to production</option>
                      <option value="staging">Set all to staging</option>
                      <option value="development">Set all to development</option>
                    </select>
                  </label>
                  <label>
                    Group
                    <input
                      onChange={(event) => setGroupOverride(event.target.value)}
                      placeholder="Keep source groups"
                      value={groupOverride}
                    />
                  </label>
                  <label>
                    Extra tags
                    <input
                      onChange={(event) => setExtraTags(event.target.value)}
                      placeholder="imported, termius"
                      value={extraTags}
                    />
                  </label>
                  <label>
                    Existing hosts
                    <select
                      onChange={(event) => setOnDuplicate(event.target.value as "skip" | "update")}
                      value={onDuplicate}
                    >
                      <option value="skip">Leave them alone</option>
                      <option value="update">Update from file</option>
                    </select>
                  </label>
                </div>
              )}

              <div className="ht-table-wrap">
                <table className="ht-table">
                  <caption className="sr-only">Hosts found in the source file</caption>
                  <thead>
                    <tr>
                      <th scope="col">Name</th>
                      <th scope="col">Address</th>
                      <th scope="col">Type</th>
                      <th scope="col">User</th>
                      <th scope="col">Env</th>
                      <th scope="col">Group</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.hosts.map((row) => {
                      const status = dispositionLabel(row.disposition);
                      return (
                        <tr key={`${row.sourceRef}-${row.address}-${row.port}`}>
                          <th scope="row">{row.name}</th>
                          <td className="ht-mono">
                            {row.address}:{row.port}
                          </td>
                          <td>{row.type.toUpperCase()}</td>
                          <td>{row.username ?? "—"}</td>
                          <td>{row.environment}</td>
                          <td>{row.group ?? "—"}</td>
                          <td>
                            <span className={cx("ht-status", `is-${status.tone}`)}>{status.text}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {preview.truncatedPreview && (
                <p className="ht-note">
                  Showing the first 500 rows. All {preview.summary.parsed} will be processed on import.
                </p>
              )}

              {preview.issues.length > 0 && (
                <details className="ht-details">
                  <summary>{preview.issues.length} row(s) will be skipped</summary>
                  <ul className="ht-issues">
                    {preview.issues.map((issue) => (
                      <li key={`${issue.sourceRef}-${issue.message}`}>
                        <code>{issue.sourceRef}</code> {issue.message}
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              <div className="ht-actions">
                <button
                  className="primary-button"
                  disabled={busy || preview.summary.new === 0 || preview.limit.wouldExceed}
                  onClick={() => void apply()}
                  type="button"
                >
                  {busy ? <Loader2 className="spin" size={15} /> : <Upload size={15} />}
                  Import {preview.summary.new} host{preview.summary.new === 1 ? "" : "s"}
                </button>
                {preview.summary.new === 0 && (
                  <span className="ht-note">Nothing new to import from this file.</span>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>Export hosts</h2>
            <p>
              Downloads the hosts you have access to. Credentials are never included — they stay in the vault.
            </p>
          </div>
        </div>

        <div className="ht-export">
          {EXPORT_OPTIONS.map((option) => (
            <a
              className="ht-export-card"
              download
              href={consoleApi.hostExportUrl(option.value)}
              key={option.value}
            >
              <span className="ht-export-icon">
                <Download size={16} />
              </span>
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
            </a>
          ))}
        </div>
      </section>
    </div>
  );
}
