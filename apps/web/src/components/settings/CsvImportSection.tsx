import { useRef, useState } from "react";
import { FileUp, Upload, CheckCircle2, AlertTriangle } from "lucide-react";
import { importMembersCsv, type ImportSummary } from "@/lib/import-members";
import { isPlanLimitError } from "@/components/ui/upgrade-prompt";

export function CsvImportSection({
  orgId,
  openBilling,
}: {
  orgId: string;
  openBilling: () => void;
}) {
  const [csv, setCsv] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    setFileName(file.name);
    setSummary(null);
    setError(null);
    const reader = new FileReader();
    reader.onload = () => setCsv(typeof reader.result === "string" ? reader.result : "");
    reader.readAsText(file);
  }

  async function handleImport() {
    setImporting(true);
    setError(null);
    setSummary(null);
    try {
      const result = await importMembersCsv({ data: { orgId, csv } });
      setSummary(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-board-text font-[family-name:var(--font-display)]">
          Import People
        </h1>
        <p className="text-sm text-board-muted mt-0.5">
          Bulk-add crew members from a CSV — paste below or upload a file
        </p>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-board-border bg-board-card p-4">
          <p className="text-xs text-board-muted leading-relaxed">
            Expected columns: <code className="text-board-text">name, email, role</code> (role is
            optional). Planning Center exports with{" "}
            <code className="text-board-text">First Name</code> /{" "}
            <code className="text-board-text">Last Name</code> columns work too. Up to 500 rows;
            people whose email is already on the roster are skipped.
          </p>
        </div>

        <textarea
          value={csv}
          onChange={(e) => {
            setCsv(e.target.value);
            setFileName(null);
            setSummary(null);
            setError(null);
          }}
          placeholder={"name,email,role\nJane Smith,jane@example.com,Camera 1\nMike Jones,mike@example.com,Audio"}
          rows={8}
          spellCheck={false}
          className="w-full px-4 py-3 rounded-xl bg-board-card border border-board-border text-sm font-mono text-board-text placeholder:text-board-muted/40 outline-none focus:border-fire-500/50 focus:ring-1 focus:ring-fire-500/20 resize-y"
        />

        <div className="flex items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = "";
            }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-board-muted border border-board-border hover:text-board-text hover:bg-board-border/50 transition-colors"
          >
            <FileUp className="w-4 h-4" />
            {fileName ?? "Upload .csv"}
          </button>
          <button
            onClick={handleImport}
            disabled={importing || !csv.trim()}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium bg-fire-500 text-white hover:bg-fire-600 disabled:opacity-50 disabled:pointer-events-none transition-colors"
          >
            <Upload className="w-4 h-4" />
            {importing ? "Importing..." : "Import"}
          </button>
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3">
            <AlertTriangle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
            <p className="text-sm text-red-300">{error}</p>
          </div>
        )}

        {summary && (
          <div className="rounded-xl border border-board-border bg-board-card p-4 space-y-3">
            <div className="flex items-center gap-4">
              <span className="flex items-center gap-1.5 text-sm text-green-400">
                <CheckCircle2 className="w-4 h-4" />
                {summary.imported} imported
              </span>
              {summary.skipped > 0 && (
                <span className="text-sm text-board-muted">
                  {summary.skipped} skipped (already on roster)
                </span>
              )}
              {summary.errors.length > 0 && (
                <span className="flex items-center gap-1.5 text-sm text-yellow-400">
                  <AlertTriangle className="w-4 h-4" />
                  {summary.errors.length} error{summary.errors.length !== 1 ? "s" : ""}
                </span>
              )}
            </div>
            {summary.errors.length > 0 && (
              <ul className="space-y-1 max-h-48 overflow-auto">
                {summary.errors.map((e, i) => (
                  <li key={i} className="text-xs text-board-muted">
                    <span className="font-mono text-yellow-400/80">line {e.line}</span> —{" "}
                    {e.message}
                    {isPlanLimitError(e.message) && (
                      <button
                        onClick={openBilling}
                        className="ml-1.5 text-fire-500 hover:text-fire-400 font-medium"
                      >
                        View plans
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
