import { type ReactNode } from "react"
import { Link } from "react-router-dom"

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <div className="step">
      <span className="step-num">{n}</span>
      <h3>{title}</h3>
      <div className="step-body">{children}</div>
    </div>
  )
}

export default function Install() {
  return (
    <div className="page narrow">
      <section className="hero-mini">
        <h1>Install</h1>
        <p>
          Free to install, free to uninstall, reversible in one click. Works on your own copy of
          the tool. Pick a surface below — you only need one.
        </p>
      </section>

      <section className="section">
        <h2 className="section-title">0. Account setup (required once)</h2>
        <div className="card">
          <p>
            Every client surface reads the same config file at <code>~/.waitshare/config.json</code>{" "}
            — your account token, device id, and an Ed25519 keypair generated on your machine. The
            private key never leaves your computer.
          </p>
          <h3>Prerequisites</h3>
          <ul className="trust-list">
            <li>Node.js 18+ (the clients use built-in <code>fetch</code> and <code>crypto</code>).</li>
            <li>A WaitShare account. If you don't have one, the setup below creates it from your email.</li>
          </ul>
          <pre className="code">node clients/shared/setup.mjs</pre>
          <p className="muted">You'll be asked for an email (no password, no card).</p>
          <p>Optional environment variables:</p>
          <pre className="code">
{`WAITSHARE_API=http://localhost:3001/api/v1  # server base URL (default)
WAITSHARE_EMAIL=you@example.com            # skip the prompt
WAITSHARE_COUNTRY=US                       # ISO country for Stripe onboarding
WAITSHARE_HOME=~/.waitshare                # config directory (default)`}
          </pre>
          <p>On success it prints your device id and writes a <code>0600</code>-permission config:</p>
          <pre className="code">
{`{
  "api": "http://localhost:3001/api/v1",
  "token": "…",
  "deviceId": "…",
  "privateKeyB64": "…",
  "publicKeyB64": "…",
  "createdAt": …
}`}
          </pre>
          <p className="muted">
            Verify the device is registered on the{" "}
            <Link to="/dashboard">dashboard → Register device key</Link>.
          </p>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">1. Opencode plugin (recommended)</h2>
        <div className="card">
          <h3>What it does</h3>
          <p>
            Subscribes to session events. When a session starts running (a genuine wait state), it
            fetches the highest-bidding ad for the surface and shows it as a clearly-marked
            sponsored line. When the run completes or idles, it signs and reports an impression.
            Runs entirely inside the opencode process — no background daemon.
          </p>
          <h3>Install</h3>
          <pre className="code">cp clients/opencode/plugin.ts ~/.config/opencode/plugins/waitshare.ts</pre>
          <p>Restart opencode. You should see a one-time notice when the plugin loads:</p>
          <pre className="code">[waitshare] Sponsored · &lt;ad line&gt;</pre>
          <h3>Verify</h3>
          <ul className="trust-list">
            <li>Start a session that takes a few seconds. A <em>Sponsored ·</em> line appears.</li>
            <li>After it finishes, the dashboard shows the credited impression within ~5s.</li>
            <li>No plugin config? Run step 0 first and reload opencode.</li>
          </ul>
          <h3>Uninstall</h3>
          <pre className="code">rm ~/.config/opencode/plugins/waitshare.ts</pre>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">2. Claude Code CLI</h2>
        <div className="card">
          <h3>What it does</h3>
          <p>
            Patches the spinner verb in <code>~/.claude/settings.json</code> so the sponsored line
            replaces the spinner text during a wait, and adds a status line. Adds{" "}
            <code>SessionStart</code> and <code>Stop</code> hooks that start and report an
            impression per session. Every edit is reversible byte-for-byte.
          </p>
          <h3>Install</h3>
          <pre className="code">bash clients/claude-code/install.sh</pre>
          <p className="muted">
            Requires Claude Code 2.1.143+ for the sponsored spinner verb; the status-line surface
            works on any version. This integration is third-party and not endorsed by Anthropic.
          </p>
          <p>The installer will:</p>
          <ul className="trust-list">
            <li>Back up <code>~/.claude/settings.json</code> to <code>.waitshare.bak</code> (once).</li>
            <li>Set the <code>statusLine</code> to run <code>waitshare.mjs status</code>.</li>
            <li>Merge the <code>start</code>/<code>report</code> hooks into your existing hooks — nothing you already had is removed.</li>
          </ul>
          <h3>Verify</h3>
          <pre className="code">node clients/claude-code/waitshare.mjs status</pre>
          <p className="muted">
            With an active ad this prints <code>Sponsored · …</code>; otherwise empty. A session of
            10+ seconds produces a credited impression you can see in the dashboard.
          </p>
          <h3>Manual commands</h3>
          <pre className="code">
{`node clients/claude-code/waitshare.mjs start    # fetch an ad for this session
node clients/claude-code/waitshare.mjs report   # sign + send the impression
node clients/claude-code/waitshare.mjs status   # print the current sponsored line
node clients/claude-code/waitshare.mjs auto     # earn for up to 2 min (demo)
node clients/claude-code/waitshare.mjs update   # verify + apply signed update`}
          </pre>
          <h3>Uninstall</h3>
          <pre className="code">
{`node clients/claude-code/patch-settings.mjs --restore ~/.claude/settings.json
# or simply: rm ~/.claude/settings.json.waitshare.bak  # then re-run install.sh`}
          </pre>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">3. VS Code extension</h2>
        <div className="card">
          <h3>What it does</h3>
          <p>
            A status-bar extension that shows the sponsored line while an impression is active,
            tracks window focus to compute the focus percentage, and reports signed impressions on
            a timer. Updates (signed manifests + sha256) are verified before install.
          </p>
          <h3>Build & install from source</h3>
          <pre className="code">
{`cd clients/vscode
npm install
npm run package        # produces waitshare-0.1.0.vsix
code --install-extension waitshare-0.1.0.vsix`}
          </pre>
          <p className="muted">
            Or load it directly in development: open <code>clients/vscode</code> in VS Code and run{" "}
            <em>Run Extension</em> from the Run panel (needs the <code>vscode</code> npm package
            installed).
          </p>
          <h3>Commands (Cmd/Ctrl-Shift-P → “WaitShare”)</h3>
          <pre className="code">
{`WaitShare: Start        fetch an ad now
WaitShare: Report       sign + send the current impression
WaitShare: Status       show device id and auto-earn state
WaitShare: Toggle auto  turn auto-earn on/off
WaitShare: Verify update   check the signed manifest
WaitShare: Update       apply a verified update`}
          </pre>
          <h3>Verify</h3>
          <ul className="trust-list">
            <li>With auto-earn on, the megaphone status item appears with the sponsored line.</li>
            <li>Impressions ≥ 10s of continuous on-screen time are credited to the dashboard.</li>
            <li>Not configured? Run step 0 first, then reload the window.</li>
          </ul>
          <h3>Uninstall</h3>
          <pre className="code">code --uninstall-extension waitshare</pre>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Verification checklist</h2>
        <ul className="trust-list">
          <li>
            <strong>Account:</strong> <code>~/.waitshare/config.json</code> exists with a device id.
          </li>
          <li>
            <strong>Device:</strong> the same device id shows on the{" "}
            <Link to="/dashboard">dashboard</Link>.
          </li>
          <li>
            <strong>First credit:</strong> run a 10+ second wait, then check “Recent impressions”
            on the dashboard.
          </li>
          <li>
            <strong>Reversible:</strong> every surface can be removed with the uninstall commands
            above.
          </li>
        </ul>
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
