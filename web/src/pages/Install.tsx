import { Link } from "react-router-dom"

export default function Install() {
  return (
    <div className="page narrow">
      <section className="hero-mini">
        <h1>Install</h1>
        <p>Free to install, free to uninstall, reversible in one click. Works on your own copy of the tool.</p>
      </section>

      <section className="section">
        <h2 className="section-title">1. Opencode plugin (recommended)</h2>
        <div className="card">
          <p>
            Copy the plugin into your opencode plugin directory. It subscribes to session events,
            fetches an ad when a run starts, and reports a signed impression when a run completes.
          </p>
          <pre className="code">cp clients/opencode/plugin.ts ~/.config/opencode/plugins/waitshare.ts</pre>
          <p className="muted">
            Restart opencode. You will see a clearly-marked sponsored line while sessions run, and
            earnings appear in your dashboard.
          </p>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">2. Claude Code CLI</h2>
        <div className="card">
          <p>
            The CLI integration patches the spinner verb in <code>~/.claude/settings.json</code>{" "}
            and adds a sponsored status line. Every edit is reversible byte-for-byte.
          </p>
          <pre className="code">bash clients/claude-code/install.sh</pre>
          <p className="muted">
            Requires Claude Code 2.1.143+ for the sponsored spinner verb; the status-line surface
            works on any version. This integration is third-party and not endorsed by Anthropic.
          </p>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">3. VS Code extension</h2>
        <div className="card">
          <p>
            The extension (in development) patches the Claude Code VS Code extension's spinner
            rendering layer. Signed update manifests are verified before install.
          </p>
          <pre className="code">code --install-extension clients/vscode/dist/waitshare.vsix</pre>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Privacy & trust, in one screen</h2>
        <ul className="trust-list">
          <li>Telemetry carries ad-event metrics only — no code, prompts, or AI responses, ever.</li>
          <li>Impression events are Ed25519-signed per device. The server rejects unsigned events.</li>
          <li>Client updates are Ed25519-signed by the server. No unsigned update is ever applied.</li>
          <li>The {`60/40`} split is a public contract and enforced in payment code.</li>
          <li>Everything you need to audit is on <Link to="/leaderboard">the transparency ledger</Link>.</li>
        </ul>
      </section>
    </div>
  )
}
