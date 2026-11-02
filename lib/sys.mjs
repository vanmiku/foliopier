// 跨平台的小工具：在 PATH 里找命令（Windows 上按 PATHEXT 找 .exe/.cmd），不依赖 which 命令
import fs from 'node:fs';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
const EXTS = IS_WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map(e => e.toLowerCase()) : [''];

export function which(cmd) {
  for (const dir of String(process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of EXTS) {
      const p = path.join(dir.replace(/^"|"$/g, ''), cmd + (ext && !cmd.toLowerCase().endsWith(ext) ? ext : ''));
      try { const st = fs.statSync(p); if (st.isFile() && (IS_WIN || (st.mode & 0o111))) return p; } catch {}
    }
  }
  return null;
}

// 写进服务、钩子、命令行入口的 node 路径。Homebrew 的 Cellar 路径带版本号（/opt/homebrew/Cellar/node/25.8.0/bin/node），
// brew upgrade 之后就没了；而且从服务里跑（PATH 不一样）和从终端跑会得到两种写法，每次都以为钩子、服务变了要重写。
// 所以找到的是 Cellar 里的，就换成指向同一个文件的固定路径（PATH 里的、/opt/homebrew/bin、/usr/local/bin）
export function nodePath() {
  const found = which('node') || process.execPath;
  if (!/[\\/]Cellar[\\/]/.test(found)) return found;
  let real; try { real = fs.realpathSync(found); } catch { return found; }
  const dirs = [...String(process.env.PATH || '').split(path.delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    if (!dir || /[\\/]Cellar[\\/]/.test(dir)) continue;
    const p = path.join(dir, 'node');
    try { if (fs.realpathSync(p) === real) return p; } catch {}
  }
  return found;
}
