// 安装、更新后要用户点头的事，放到首页「等你处理」里点一下就做，不用去命令行：
//   codex-trust：Codex 只运行用户信任过的钩子。点「允许」由 mydash 给自己的那几条记上信任（lib/integrate.mjs）
//   boot：开机就启动要管理员权限。点了由 macOS 自己弹出密码框（osascript … with administrator privileges），
//         密码只在系统的框里输，不经过 mydash；框出现在这台 Mac 的屏幕上
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { HOME, readConfig } from './store.mjs';
import { codexTrustPending, trustCodexHooks } from './integrate.mjs';
import { SERVICES, DAEMON_DIR } from './service.mjs';
import { nodePath } from './sys.mjs';
import { t } from './i18n.mjs';

const APP = path.join(HOME, 'app');
const BOOT_STATE = path.join(HOME, 'state', 'boot-setup.json');
const LOG = path.join(HOME, 'logs', 'boot-setup.log');

// 安装程序放在 state/boot/ 里、还没装进系统（或者装着的和它不一样）的开机服务
export function bootPending() {
  if (process.platform !== 'darwin' || readConfig().service !== 'launchd-boot') return false;
  return ['server', 'tailscaled'].some(k => {
    const label = SERVICES[k].launchd;
    let want; try { want = fs.readFileSync(path.join(HOME, 'state', 'boot', `${label}.plist`), 'utf8'); } catch { return false; }
    try { return fs.readFileSync(path.join(DAEMON_DIR, `${label}.plist`), 'utf8') !== want; } catch { return true; }
  });
}
const readBoot = () => { try { return JSON.parse(fs.readFileSync(BOOT_STATE, 'utf8')); } catch { return {}; } };
const writeBoot = x => { fs.mkdirSync(path.dirname(BOOT_STATE), { recursive: true }); fs.writeFileSync(BOOT_STATE, JSON.stringify(x, null, 2)); };
function bootRunning(s) { return Boolean(s.running && Date.now() - Date.parse(s.startedAt || 0) < 5 * 60_000); }

export function setupStatus() {
  const b = readBoot();
  return { codexTrust: codexTrustPending(), boot: { pending: bootPending(), running: bootRunning(b), last: b.last || null } };
}
// 首页「等你处理」里的卡片要不要出现
export function setupCards() {
  const s = setupStatus();
  return { codexTrust: s.codexTrust > 0, boot: s.boot.pending || s.boot.running };
}

export function allowCodexHooks() { return trustCodexHooks(); }

export function bootOutcome(err, text) {
  const canceled = Boolean(err && /-128\b|-60006\b|cancel/i.test(text));
  const code = !err ? null : canceled ? 'canceled' : /-60007\b/.test(text) ? 'interaction-unavailable'
    : /-60005\b/.test(text) ? 'denied' : err.killed ? 'timeout' : 'failed';
  return { ok: !err, canceled, code, error: err ? text.slice(-300) : null, at: new Date().toISOString() };
}

// A one-shot LaunchAgent owns the GUI/audit session; detaching a process from a
// system daemon alone does not make macOS authorization UI available (-60007).
export function bootAgent({ uid, script, node = nodePath() }) {
  if (!Number.isInteger(uid) || uid <= 0) throw new Error('A logged-in user is required.');
  const label = `${SERVICES.server.launchd}.boot-setup`;
  const runner = `const{execFile}=require("child_process"),fs=require("fs");const[state,log,script]=process.argv.slice(1);
execFile("/usr/bin/osascript",["-e",script],{timeout:300000},(err,out,errOut)=>{
  const text=String(errOut||out||"").trim();fs.appendFileSync(log,new Date().toISOString()+" "+(err?"failed: ":"ok: ")+text+"\\n");
  fs.writeFileSync(state,JSON.stringify({running:false,last:(${bootOutcome.toString()})(err,text)},null,2));});`;
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const args = [node, '-e', runner, BOOT_STATE, LOG, script];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${esc(label)}</string>
<key>ProgramArguments</key><array>${args.map(a => `<string>${esc(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${esc(HOME)}</string>
<key>EnvironmentVariables</key><dict><key>MYDASH_HOME</key><string>${esc(HOME)}</string><key>HOME</key><string>${esc(os.userInfo().homedir)}</string></dict>
<key>RunAtLoad</key><true/><key>LimitLoadToSessionType</key><string>Aqua</string>
<key>ProcessType</key><string>Interactive</string></dict></plist>\n`;
  return { label, domain: `gui/${uid}`, xml };
}

// Launch in the existing GUI session, without changing user identity or storing
// credentials. The separate agent survives the server restart it authorizes.
export function startBootSetup() {
  if (!bootPending()) return { ok: false, error: 'nothing to do' };
  if (bootRunning(readBoot())) return { ok: false, error: 'running' };
  const uid = process.getuid();
  try {
    if (fs.statSync('/dev/console').uid !== uid) return { ok: false, error: 'interaction-unavailable' };
    execFileSync('/bin/launchctl', ['print', `gui/${uid}`], { stdio: 'ignore', timeout: 3000 });
  } catch { return { ok: false, error: 'interaction-unavailable' }; }
  const user = os.userInfo().username;
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd = `/usr/bin/env SUDO_USER=${q(user)} MYDASH_HOME=${q(HOME)} ${q(nodePath())} ${q(path.join(APP, 'bin', 'mydash.mjs'))} service boot`;
  const as = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const script = `do shell script ${as(cmd)} with prompt ${as(t('FolioPier AI wants to start at boot, before anyone logs in.'))} with administrator privileges`;
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  const plan = bootAgent({ uid, script });
  const plist = path.join(HOME, 'state', 'boot-setup-agent.plist');
  fs.writeFileSync(plist, plan.xml, { mode: 0o600 });
  writeBoot({ ...readBoot(), running: true, startedAt: new Date().toISOString() });
  try {
    try { execFileSync('/bin/launchctl', ['bootout', `${plan.domain}/${plan.label}`], { stdio: 'ignore', timeout: 3000 }); } catch {}
    execFileSync('/bin/launchctl', ['bootstrap', plan.domain, plist], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  } catch (e) {
    writeBoot({ running: false, last: { ...bootOutcome(e, String(e.stderr || e.message)), code: 'interaction-unavailable' } });
    return { ok: false, error: 'interaction-unavailable' };
  }
  return { ok: true };
}
