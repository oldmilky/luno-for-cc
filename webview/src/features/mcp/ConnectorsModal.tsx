// ─────────────────────────────────────────────────────────────
// Connectors modal — Luno's analog of claude.ai/customize/connectors.
//
// Shows the curated catalog + user-added custom connectors, each
// with a Connect / Disconnect button that drives the host-side
// OAuth + MCP-initialize flow. Adds an "Add custom connector"
// form for URL-based servers that aren't in the curated list.
//
// All actual work (HTTP + OAuth + tool discovery) happens in the
// extension host. This component is a thin RPC client.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import { BACKDROP, OVERLAY_PANEL } from "../../design/motion";
import { AnimatePresence, motion } from "framer-motion";
import { Icon, IconName } from "../../design/icons";
import { Tooltip } from "../../design/primitives";
import {
  send,
  onMessage,
  ConnectorView,
  CustomConnectorDraft
} from "../../lib/rpc";
import s from "./ConnectorsModal.module.scss";

export interface ConnectorsModalProps {
  open: boolean;
  onClose: () => void;
}

type Tab = "all" | "connected" | "custom";

type Toast = { ok: boolean; text: string } | null;

export function ConnectorsModal({ open, onClose }: ConnectorsModalProps) {
  const [connectors, setConnectors] = useState<ConnectorView[]>([]);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [toast, setToast] = useState<Toast>(null);
  // When set, an API-token prompt is shown for this local preset (e.g. Figma).
  const [apiKeyPrompt, setApiKeyPrompt] = useState<{
    id: string;
    name: string;
    label: string;
    hint?: string;
  } | null>(null);

  // Refresh + subscribe to server messages while open.
  useEffect(() => {
    if (!open) return;
    send({ type: "requestConnectors" });
    return onMessage((m) => {
      if (m.type === "connectorsList") {
        setConnectors(m.connectors);
      } else if (m.type === "connectorResult") {
        // "cancel" is an explicit user-initiated bail-out, not an error and
        // not a success worth toasting. Just clear the spinner.
        if (m.action === "cancel") {
          setBusyId(null);
          return;
        }
        setBusyId(null);
        if (m.cancelled) {
          // Connect threw OAuthCancelled — same story: silent unstuck.
          return;
        }
        if (m.ok) {
          const verb =
            m.action === "connect"
              ? m.connector?.managed
                ? "Refreshed"
                : "Connected"
              : m.action === "disconnect"
                ? "Disconnected"
                : m.action === "add"
                  ? "Added"
                  : "Removed";
          setToast({ ok: true, text: `${verb} ${m.connector?.name ?? m.id}.` });
          if (m.action === "add") setAddOpen(false);
        } else {
          setToast({ ok: false, text: m.error ?? "Something went wrong." });
        }
        window.setTimeout(() => setToast(null), 4500);
      }
    });
  }, [open]);

  // Close on Esc.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return connectors.filter((c) => {
      // "Connected" means servers the user connected *in Luno* — managed
      // (Claude Code) servers are always-active but live under their own pill.
      if (tab === "connected" && (c.status !== "connected" || c.managed))
        return false;
      if (tab === "custom" && c.builtIn) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.vendor.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q)
      );
    });
  }, [connectors, query, tab]);

  const counts = useMemo(() => {
    const connected = connectors.filter(
      (c) => c.status === "connected" && !c.managed
    ).length;
    const custom = connectors.filter((c) => !c.builtIn).length;
    return { connected, custom };
  }, [connectors]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className={s.backdrop} onMouseDown={onClose} {...BACKDROP}>
          <motion.div
            className={`${s.modal} ${s.market}`}
            {...OVERLAY_PANEL}
            role="dialog"
            aria-label="Connectors"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <header className={s.head}>
              <div className={s.headTitles}>
                <h2 className={s.title}>Connectors</h2>
                <p className={s.sub}>
                  Browse and connect to remote MCP servers. Authentication uses
                  OAuth — your browser will open to authorize.
                </p>
              </div>
              <button
                type="button"
                className={s.close}
                onClick={onClose}
                aria-label="Close"
              >
                <Icon name="x" size={14} />
              </button>
            </header>

            <div className={s.toolbar}>
              <div className={s.search}>
                <Icon name="search" size={13} />
                <input
                  type="text"
                  placeholder="Search connectors…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  autoFocus
                  spellCheck={false}
                />
              </div>
              <div className={s.tabs} role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "all"}
                  className={`${s.tab}${tab === "all" ? ` ${s.tabActive}` : ""}`}
                  onClick={() => setTab("all")}
                >
                  All
                  <span className={s.tabCount}>{connectors.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "connected"}
                  className={`${s.tab}${tab === "connected" ? ` ${s.tabActive}` : ""}`}
                  onClick={() => setTab("connected")}
                  disabled={counts.connected === 0}
                >
                  Connected
                  {counts.connected > 0 && (
                    <span className={s.tabCount}>{counts.connected}</span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "custom"}
                  className={`${s.tab}${tab === "custom" ? ` ${s.tabActive}` : ""}`}
                  onClick={() => setTab("custom")}
                  disabled={counts.custom === 0}
                >
                  Custom
                  {counts.custom > 0 && (
                    <span className={s.tabCount}>{counts.custom}</span>
                  )}
                </button>
                <button
                  type="button"
                  className={`${s.btn} ${s.primary} ${s.addBtn}`}
                  onClick={() => setAddOpen(true)}
                >
                  <Icon name="plus" size={11} />
                  Add custom
                </button>
              </div>
            </div>

            <div className={s.grid}>
              {filtered.length === 0 ? (
                <div className={s.empty}>
                  <Icon name="search" size={20} />
                  <span>
                    {connectors.length === 0
                      ? "Loading connectors…"
                      : query
                        ? `No connectors match "${query}".`
                        : "No connectors in this tab yet."}
                  </span>
                </div>
              ) : (
                filtered.map((c) => (
                  <ConnectorCard
                    key={c.id}
                    connector={c}
                    busy={busyId === c.id}
                    onConnect={() => {
                      // Local API-token presets (e.g. Figma) prompt for the token
                      // first, then connect via connectorConnectWithApiKey.
                      if (c.apiKeyEnv) {
                        setApiKeyPrompt({
                          id: c.id,
                          name: c.name,
                          ...c.apiKeyEnv
                        });
                        return;
                      }
                      setBusyId(c.id);
                      send({ type: "connectorConnect", id: c.id });
                    }}
                    onCancelConnect={() => {
                      // Optimistic: drop the spinner now; the host echoes back
                      // a "cancel" result that confirms the abort.
                      send({ type: "connectorCancelConnect", id: c.id });
                      setBusyId(null);
                    }}
                    onDisconnect={() => {
                      setBusyId(c.id);
                      send({ type: "connectorDisconnect", id: c.id });
                    }}
                    onRemove={() => {
                      setBusyId(c.id);
                      send({ type: "connectorRemoveCustom", id: c.id });
                    }}
                    onSetupViaClaudeCode={() => {
                      send({ type: "connectorSetupViaClaudeCode", id: c.id });
                      setToast({
                        ok: true,
                        text: "Opening Claude Code — finish in the /mcp menu."
                      });
                      window.setTimeout(() => setToast(null), 5000);
                    }}
                  />
                ))
              )}
            </div>

            {/* Both nested dialogs need their own AnimatePresence: this one is
                already inside the parent's, but that instance only tracks the
                modal itself. A child that mounts and unmounts underneath it is
                invisible to it. */}
            <AnimatePresence>
              {addOpen && (
                <AddCustomForm
                  onCancel={() => setAddOpen(false)}
                  onSubmit={(draft) => {
                    setBusyId("__add__");
                    send({ type: "connectorAddCustom", draft });
                  }}
                />
              )}

              {apiKeyPrompt && (
                <ApiKeyPrompt
                  name={apiKeyPrompt.name}
                  label={apiKeyPrompt.label}
                  hint={apiKeyPrompt.hint}
                  onCancel={() => setApiKeyPrompt(null)}
                  onSubmit={(apiKey) => {
                    setBusyId(apiKeyPrompt.id);
                    send({
                      type: "connectorConnectWithApiKey",
                      id: apiKeyPrompt.id,
                      apiKey
                    });
                    setApiKeyPrompt(null);
                  }}
                />
              )}
            </AnimatePresence>

            {toast && (
              <div
                className={`${s.toast} ${toast.ok ? s.toastOk : s.toastErr}`}
              >
                <Icon name={toast.ok ? "check" : "x"} size={11} />
                <span>{toast.text}</span>
              </div>
            )}

            <footer className={s.foot}>
              <span>
                Connectors authenticate via OAuth. Tokens are stored in VS
                Code's SecretStorage.
              </span>
            </footer>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ── Card ───────────────────────────────────────────────────

function ConnectorCard({
  connector,
  busy,
  onConnect,
  onCancelConnect,
  onDisconnect,
  onRemove,
  onSetupViaClaudeCode
}: {
  connector: ConnectorView;
  busy: boolean;
  onConnect: () => void;
  onCancelConnect: () => void;
  onDisconnect: () => void;
  onRemove: () => void;
  onSetupViaClaudeCode: () => void;
}) {
  const connected = connector.status === "connected";
  const errored = connector.status === "error";
  const managed = !!connector.managed;
  const isStdio = connector.transport === "stdio";
  // Authorized through Claude Code's /mcp flow (per `claude mcp list`).
  const ccConnected = !!connector.connectedViaClaudeCode;
  // Vendor blocks third-party OAuth registration (e.g. Figma) — can't Connect
  // directly; must be authenticated through Claude Code.
  const claudeCodeAuth =
    !!connector.requiresClaudeCodeAuth && !connected && !ccConnected;
  const iconName = (connector.icon as IconName) ?? "cloud";
  // Removing a managed server edits the user's Claude Code config, so it takes
  // a deliberate two-click confirm.
  const [confirmRemove, setConfirmRemove] = useState(false);
  // The card's hover label + the mono subtitle point at the endpoint:
  // a URL for remote servers, the command line for stdio ones.
  const target = connector.url ?? connector.command ?? "";

  return (
    <Tooltip label={target} wrap disabled={!target}>
      <article className={`${s.card}${connected ? ` ${s.cardInstalled}` : ""}`}>
        <div className={s.cardHead}>
          <span className={s.cardIcon}>
            <Icon name={iconName} size={14} />
          </span>
          <div className={s.cardTitles}>
            <span className={s.cardName}>{connector.name}</span>
            <span className={s.cardPub}>
              <span className={s.cardCat}>{connector.vendor}</span>
              {managed ? (
                <>
                  <span className={s.cardDot} />
                  <span className={s.cardTag}>
                    Claude Code{connector.scope ? ` · ${connector.scope}` : ""}
                  </span>
                </>
              ) : !connector.builtIn ? (
                <>
                  <span className={s.cardDot} />
                  <span className={s.cardTag}>
                    {isStdio ? "local" : "custom"}
                  </span>
                </>
              ) : null}
              {connector.toolCount > 0 && (
                <>
                  <span className={s.cardDot} />
                  <span className={s.cardTools}>
                    {connector.toolCount} tool
                    {connector.toolCount === 1 ? "" : "s"}
                  </span>
                </>
              )}
            </span>
          </div>
        </div>
        <p className={s.cardDesc}>{connector.description}</p>

        {(isStdio || managed) && target && (
          <p className={`${s.cardDesc} ${s.cardTarget}`}>{target}</p>
        )}

        {errored && connector.lastError && (
          <p className={`${s.cardDesc} ${s.cardError}`}>
            {connector.lastError}
          </p>
        )}

        {claudeCodeAuth && (
          <p className={`${s.cardDesc} ${s.cardNote}`}>
            {connector.name} blocks third-party sign-in, so connect it through
            Claude Code: run <code>claude</code> in a terminal, type{" "}
            <code>/mcp</code>, and authorize {connector.name}. It then appears
            here automatically.
          </p>
        )}

        <div className={s.cardActions}>
          {connector.homepage && (
            <button
              type="button"
              className={`${s.btn} ${s.ghost}`}
              onClick={() =>
                send({ type: "openExternal", url: connector.homepage! })
              }
            >
              <Icon name="book" size={11} />
              Docs
            </button>
          )}

          {managed ? (
            // Read-only — these are configured in Claude Code's own config, so no
            // Connect/Disconnect/Remove. The user can re-check the live tool list
            // (Luno fetches it with the credentials Claude Code already stored).
            busy ? (
              <span
                className={`${s.btn} ${s.ghost} ${s.btnStatic}`}
                aria-live="polite"
              >
                <span className={s.spinner} />
                Checking…
              </span>
            ) : (
              <>
                <Tooltip label="Configured in Claude Code — manage with the `claude mcp` CLI">
                  <span className={s.managed}>
                    <Icon name="check" size={11} />
                    Managed by Claude Code
                  </span>
                </Tooltip>
                <Tooltip label="Re-check this server's tools">
                  <button
                    type="button"
                    className={`${s.btn} ${s.ghost}`}
                    onClick={onConnect}
                  >
                    <Icon name="refresh" size={11} />
                    Refresh
                  </button>
                </Tooltip>
                <Tooltip
                  label={`Remove "${connector.name}" from your Claude Code config (claude mcp remove)`}
                >
                  <button
                    type="button"
                    className={`${s.btn} ${s.danger}`}
                    onClick={() => {
                      if (confirmRemove) {
                        onRemove();
                        setConfirmRemove(false);
                      } else {
                        setConfirmRemove(true);
                      }
                    }}
                    onBlur={() => setConfirmRemove(false)}
                  >
                    <Icon name="x" size={11} />
                    {confirmRemove ? "Confirm remove?" : "Remove"}
                  </button>
                </Tooltip>
              </>
            )
          ) : ccConnected ? (
            // Authorized through Claude Code's /mcp flow — read-only here; Claude
            // Code owns the token and loads it for every turn.
            <Tooltip label="Authorized in Claude Code — available in your turns">
              <span className={`${s.btn} ${s.ghost} ${s.btnStatic} ${s.btnOk}`}>
                <Icon name="check" size={11} />
                Connected via Claude Code
              </span>
            </Tooltip>
          ) : (
            <>
              {!connector.builtIn && !connected && (
                <button
                  type="button"
                  className={`${s.btn} ${s.danger}`}
                  onClick={onRemove}
                  disabled={busy}
                >
                  <Icon name="x" size={11} />
                  Remove
                </button>
              )}
              {connected ? (
                <button
                  type="button"
                  className={`${s.btn} ${s.ghost} ${s.pushRight}`}
                  onClick={onDisconnect}
                  disabled={busy}
                >
                  <Icon name="logout" size={11} />
                  Disconnect
                </button>
              ) : busy ? (
                isStdio ? (
                  // Local spawn — no browser round-trip, so just a spinner.
                  <span
                    className={`${s.btn} ${s.ghost} ${s.btnStatic}`}
                    aria-live="polite"
                  >
                    <span className={s.spinner} />
                    Starting…
                  </span>
                ) : (
                  // While OAuth is in-flight, the spinner sits next to a real
                  // Cancel button so a stuck browser tab never freezes the UI.
                  <>
                    <span
                      className={`${s.btn} ${s.ghost} ${s.btnStatic}`}
                      aria-live="polite"
                    >
                      <span className={s.spinner} />
                      Waiting for browser…
                    </span>
                    <Tooltip label="Cancel and close the local OAuth listener">
                      <button
                        type="button"
                        className={`${s.btn} ${s.danger}`}
                        onClick={onCancelConnect}
                      >
                        <Icon name="x" size={11} />
                        Cancel
                      </button>
                    </Tooltip>
                  </>
                )
              ) : claudeCodeAuth ? (
                <Tooltip label="Open Claude Code and start the /mcp connector setup">
                  <button
                    type="button"
                    className={`${s.btn} ${s.primary} ${s.pushRight}`}
                    onClick={onSetupViaClaudeCode}
                  >
                    <Icon name="terminal" size={11} />
                    Set up via Claude Code
                  </button>
                </Tooltip>
              ) : (
                <button
                  type="button"
                  className={`${s.btn} ${s.primary}`}
                  onClick={onConnect}
                >
                  <Icon
                    name={isStdio && !connector.apiKeyEnv ? "play" : "arrow"}
                    size={11}
                  />
                  {isStdio && !connector.apiKeyEnv ? "Start" : "Connect"}
                </button>
              )}
            </>
          )}
        </div>
      </article>
    </Tooltip>
  );
}

// ── Add custom form ────────────────────────────────────────

function AddCustomForm({
  onCancel,
  onSubmit
}: {
  onCancel: () => void;
  onSubmit: (draft: CustomConnectorDraft) => void;
}) {
  const [kind, setKind] = useState<"remote" | "stdio">("remote");
  const [name, setName] = useState("");
  // remote
  const [url, setUrl] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  // stdio
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");

  const canSubmit =
    name.trim().length > 0 &&
    (kind === "remote" ? url.trim().length > 0 : command.trim().length > 0);

  const submit = () => {
    if (kind === "stdio") {
      onSubmit({
        name: name.trim(),
        kind: "stdio",
        command: command.trim(),
        args: parseLines(argsText),
        env: parseEnv(envText)
      });
    } else {
      onSubmit({
        name: name.trim(),
        kind: "remote",
        url: url.trim(),
        clientId: clientId.trim() || undefined,
        clientSecret: clientSecret.trim() || undefined
      });
    }
  };

  return (
    <motion.div
      className={`${s.backdrop} ${s.backdropNested}`}
      onMouseDown={onCancel}
      {...BACKDROP}
    >
      <motion.div
        className={`${s.modal} ${s.formModal}`}
        {...OVERLAY_PANEL}
        role="dialog"
        aria-label="Add custom connector"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={s.head}>
          <div className={s.headTitles}>
            <h2 className={s.title}>Add custom connector</h2>
            <p className={s.sub}>
              {kind === "remote"
                ? "Paste the URL of a remote MCP server. We'll discover its auth metadata, register a client, and open your browser to authorize."
                : "Run a local MCP server as a command (stdio) — the same as `claude mcp add <name> -- <command>`."}
            </p>
          </div>
          <button
            type="button"
            className={s.close}
            onClick={onCancel}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </header>

        <div className={s.formBody}>
          {/* Transport toggle — remote (URL) vs local (stdio command). */}
          <div role="tablist" className={s.kindToggle}>
            {(["remote", "stdio"] as const).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                onClick={() => setKind(k)}
                className={`${s.kindBtn}${kind === k ? ` ${s.kindBtnActive}` : ""}`}
              >
                <Icon
                  name={k === "remote" ? "cloud" : "terminal"}
                  size={11}
                  className={s.kindIcon}
                />
                {k === "remote" ? "Remote URL" : "Local command"}
              </button>
            ))}
          </div>

          <Field label="Name">
            <input
              type="text"
              placeholder={kind === "remote" ? "My MCP server" : "filesystem"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              spellCheck={false}
              className={s.input}
              autoFocus
            />
          </Field>

          {kind === "remote" ? (
            <>
              <Field label="Server URL" hint="HTTPS only (except localhost).">
                <input
                  type="text"
                  placeholder="https://mcp.example.com/mcp"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  spellCheck={false}
                  className={s.input}
                />
              </Field>

              <button
                type="button"
                className={s.advancedToggle}
                onClick={() => setAdvanced((v) => !v)}
              >
                {advanced ? "Hide" : "Show"} advanced options
                <Icon
                  name={advanced ? "chevronU" : "chevronD"}
                  size={11}
                  className={s.advancedChevron}
                />
              </button>

              {advanced && (
                <>
                  <Field
                    label="OAuth client_id"
                    hint="Leave blank to use Dynamic Client Registration."
                  >
                    <input
                      type="text"
                      placeholder="(optional)"
                      value={clientId}
                      onChange={(e) => setClientId(e.target.value)}
                      spellCheck={false}
                      className={s.input}
                    />
                  </Field>
                  <Field
                    label="OAuth client_secret"
                    hint="Stored in SecretStorage. Optional."
                  >
                    <input
                      type="password"
                      placeholder="(optional)"
                      value={clientSecret}
                      onChange={(e) => setClientSecret(e.target.value)}
                      spellCheck={false}
                      className={s.input}
                    />
                  </Field>
                </>
              )}
            </>
          ) : (
            <>
              <Field label="Command" hint="The executable to run.">
                <input
                  type="text"
                  placeholder="npx"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  spellCheck={false}
                  className={s.input}
                />
              </Field>
              <Field label="Arguments" hint="One per line.">
                <textarea
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder={
                    "-y\n@modelcontextprotocol/server-filesystem\n/path/to/allowed/dir"
                  }
                  spellCheck={false}
                  rows={3}
                  className={`${s.input} ${s.textarea}`}
                />
              </Field>
              <Field
                label="Environment"
                hint="KEY=VALUE, one per line. Optional."
              >
                <textarea
                  value={envText}
                  onChange={(e) => setEnvText(e.target.value)}
                  placeholder={"API_KEY=…"}
                  spellCheck={false}
                  rows={2}
                  className={`${s.input} ${s.textarea}`}
                />
              </Field>
            </>
          )}

          <div className={s.actions}>
            <button
              type="button"
              className={`${s.btn} ${s.ghost}`}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.primary}`}
              disabled={!canSubmit}
              onClick={submit}
            >
              <Icon name="plus" size={11} />
              Add connector
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

/** Split a textarea into trimmed, non-empty lines (one stdio arg per line). */
function parseLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Parse `KEY=VALUE` lines into an env record (undefined when empty). */
function parseEnv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    if (key) out[key] = t.slice(eq + 1).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

// ── API-token prompt (local presets like Figma) ────────────

function ApiKeyPrompt({
  name,
  label,
  hint,
  onCancel,
  onSubmit
}: {
  name: string;
  label: string;
  hint?: string;
  onCancel: () => void;
  onSubmit: (apiKey: string) => void;
}) {
  const [value, setValue] = useState("");
  const canSubmit = value.trim().length > 0;
  return (
    <motion.div
      className={`${s.backdrop} ${s.backdropNested}`}
      onMouseDown={onCancel}
      {...BACKDROP}
    >
      <motion.div
        className={`${s.modal} ${s.promptModal}`}
        {...OVERLAY_PANEL}
        role="dialog"
        aria-label={`Connect ${name}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className={s.head}>
          <div className={s.headTitles}>
            <h2 className={s.title}>Connect {name}</h2>
            <p className={s.sub}>
              Runs locally — no browser sign-in. The token is stored in VS
              Code's SecretStorage and never leaves your machine except to{" "}
              {name}.
            </p>
          </div>
          <button
            type="button"
            className={s.close}
            onClick={onCancel}
            aria-label="Close"
          >
            <Icon name="x" size={14} />
          </button>
        </header>
        <div className={s.formBody}>
          <Field label={label} hint={hint}>
            <input
              type="password"
              placeholder="Paste your token"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              spellCheck={false}
              className={s.input}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) onSubmit(value.trim());
              }}
            />
          </Field>
          <div className={s.actions}>
            <button
              type="button"
              className={`${s.btn} ${s.ghost}`}
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="button"
              className={`${s.btn} ${s.primary}`}
              disabled={!canSubmit}
              onClick={() => onSubmit(value.trim())}
            >
              <Icon name="arrow" size={11} />
              Connect
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Field({
  label,
  hint,
  children
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={s.field}>
      <span className={s.fieldLabel}>{label}</span>
      {children}
      {hint && <span className={s.fieldHint}>{hint}</span>}
    </label>
  );
}
