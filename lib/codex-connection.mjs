// Select a read-verified native connection before dispatch. Never retry a mutation
// through another transport: a lost receipt must remain uncertain.
import { codexApp } from './codex-app.mjs';
import { codexDaemon } from './codex-daemon.mjs';
const restricted = new Set(['daemon_not_loaded', 'daemon_readonly', 'app_mismatch', 'app_incompatible']);
export class CodexConnection {
  constructor({ desktop = codexApp, daemon = codexDaemon } = {}) {
    this.desktop = desktop;
    this.daemon = daemon;
    this.routes = new Map();
  }
  remember(id, source, view) {
    if (this.routes.size >= 100 && !this.routes.has(id)) this.routes.delete(this.routes.keys().next().value);
    this.routes.set(id, source);
    return { ...view, connectionSource: source };
  }
  peek(id, cwd) {
    const source = this.routes.get(id);
    if (source) return { ...this[source].peek(id, cwd), connectionSource: source };
    return { ...this.desktop.peek(id, cwd), connectionSource: 'desktop' };
  }
  async observe(id, cwd) {
    // A currently verified desktop route stays on its existing broker.
    if (this.routes.get(id) === 'desktop' && this.desktop.peek(id, cwd).connected)
      return this.remember(id, 'desktop', await this.desktop.observe(id, cwd));
    const native = await this.daemon.observe(id, cwd);
    if (native.connected || restricted.has(native.reason)) return this.remember(id, 'daemon', native);
    return this.remember(id, 'desktop', await this.desktop.observe(id, cwd));
  }
  async start(id, cwd, input) {
    const source = this.routes.get(id);
    if (!source) throw Object.assign(Error('not-connected'), { uncertain: false });
    return this[source].start(id, cwd, input);
  }
}
export const codexConnection = new CodexConnection();
