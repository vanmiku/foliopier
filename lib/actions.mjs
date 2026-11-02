// 安装、更新后要用户点头的事，放到首页「等你处理」里点一下就做，不用去命令行：
//   codex-trust：Codex 只运行用户信任过的钩子。点「允许」由 mydash 给自己的那几条记上信任（lib/integrate.mjs）
//   boot：开机就启动要管理员权限。点了由 macOS 自己弹出密码框（osascript … with administrator privileges），
//         密码只在系统的框里输，不经过 mydash；框出现在这台 Mac 的屏幕上
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

// 弹出 macOS 的管理员密码框，跑一次 mydash service boot。换服务时正在跑的这个服务会被停掉，
// 所以经一个马上退出的中间进程启动、和服务脱开（同 lib/update.mjs 的 startUpdate），结果记进 state/boot-setup.json
export function startBootSetup() {
  if (!bootPending()) return { ok: false, error: 'nothing to do' };
  if (bootRunning(readBoot())) return { ok: false, error: 'running' };
  const user = os.userInfo().username;
  const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const cmd = `/usr/bin/env SUDO_USER=${q(user)} MYDASH_HOME=${q(HOME)} ${q(nodePath())} ${q(path.join(APP, 'bin', 'mydash.mjs'))} service boot`;
  const as = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const script = `do shell script ${as(cmd)} with prompt ${as(t('mydash wants to start at boot, before anyone logs in.'))} with administrator privileges`;
  // 中间进程：跑 osascript，等它结束，把结果写下来（用户在框里点了取消也算结束）
  const runner = `const{execFile}=require("child_process"),fs=require("fs");const[state,log,script]=process.argv.slice(1);
execFile("/usr/bin/osascript",["-e",script],{timeout:300000},(err,out,errOut)=>{
  const text=String(errOut||out||"").trim();fs.appendFileSync(log,new Date().toISOString()+" "+(err?"failed: ":"ok: ")+text+"\\n");
  const last={ok:!err,canceled:/-128|cancel/i.test(text),error:err?text.slice(-300):null,at:new Date().toISOString()};
  fs.writeFileSync(state,JSON.stringify({running:false,last},null,2));});`;
  const launcher = 'const{spawn}=require("child_process");const a=process.argv.slice(1);spawn(process.execPath,["-e",a[0],...a.slice(1)],{detached:true,stdio:"ignore"}).unref();';
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  writeBoot({ ...readBoot(), running: true, startedAt: new Date().toISOString() });
  try {
    spawn(process.execPath, ['-e', launcher, runner, BOOT_STATE, LOG, script], { detached: true, stdio: 'ignore', cwd: HOME }).unref();
  } catch (e) { writeBoot({ running: false, last: { ok: false, error: e.message, at: new Date().toISOString() } }); return { ok: false, error: e.message }; }
  return { ok: true };
}
