"""Rebuild native identity icons and synthetic README screenshots.
Requires test/requirements-ui.txt and Chromium. Uses isolated data; never changes an installation.
Run: python tools/brand-assets.py
"""
import base64
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'readme'

def uri(p):
    return 'data:image/png;base64,' + base64.b64encode(p.read_bytes()).decode()

def png_icons(page):
    svg = (ROOT / 'static' / 'icon.svg').read_text()
    for size in [16, 32, 48, 180, 192, 512]:
        page.set_viewport_size({'width': size, 'height': size})
        page.set_content('<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>' + svg)
        page.screenshot(path=str(ROOT / 'static' / f'icon-{size}.png'), omit_background=True)
    payloads = [(n, (ROOT / 'static' / f'icon-{n}.png').read_bytes()) for n in [16, 32, 48]]
    offset = 6 + 16 * len(payloads)
    header = struct.pack('<HHH', 0, 1, len(payloads))
    entries = []
    for size, data in payloads:
        entries.append(struct.pack('<BBBBHHII', size, size, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    (ROOT / 'static' / 'favicon.ico').write_bytes(header + b''.join(entries) + b''.join(data for _, data in payloads))
    for lang in ['en', 'zh']:
        shutil.copy2(ROOT / 'static' / 'icon-512.png', ROOT / 'welcome' / lang / 'logo.png')

def ports():
    while True:
        a = socket.socket();a.bind(('127.0.0.1', 0));port = a.getsockname()[1]
        b = socket.socket()
        try:
            b.bind(('127.0.0.1', port + 1));a.close();b.close();return port
        except OSError:
            a.close();b.close()

def publish(tmp, env, project, slug, title, text, agent='codex', note=None, extras=None):
    source = tmp / project;source.mkdir(exist_ok=True)
    file = source / (slug + '.md');file.write_text(text)
    args = ['node', str(ROOT / 'bin' / 'foliopier.mjs'), 'publish', str(file), *(str(x) for x in (extras or [])), '--force-project', project, '--slug', slug, '--title', title, '--json']
    if note:args += ['--note', note]
    r = subprocess.run(args, cwd=source, env={**env, 'MYDASH_AGENT': agent}, capture_output=True, text=True, timeout=45)
    if r.returncode:raise RuntimeError(r.stderr or r.stdout)
    return json.loads(r.stdout.strip().splitlines()[-1])

def setup(tmp, port, lang):
    home = tmp / 'home';home.mkdir()
    (home / 'config.json').write_text(json.dumps({'port':port,'contentPort':port+1,'lang':lang,'access':'local','baseUrl':f'http://127.0.0.1:{port}','update':{'mode':'off'},'prompts':{'pushDelay':-1}}))
    env = dict(os.environ)
    for k in list(env):
        if k.startswith('MYDASH_') or k in ['CODEX_THREAD_ID','CLAUDE_CODE_SESSION_ID']:env.pop(k, None)
    env.update(MYDASH_HOME=str(home),MYDASH_LANG=lang,MYDASH_CODEX_HOME=str(tmp/'codex'),MYDASH_CLAUDE_HOME=str(tmp/'claude'))
    zh = lang == 'zh'
    title = '上线前审阅：让成果准备好交付' if zh else 'Ready for review: from draft to delivery'
    body = ('# 让成果准备好交付\n\n先确认变更，再分享给需要的人。所有数据均为演示内容。\n\n## 本轮完成\n\n- 文档与原型已整理，按文件切换查看。\n- 保留版本变化，阅读和反馈都有上下文。\n- 分享选定成果时设置访问码和有效期。\n\n## 交付检查\n\n| 内容 | 状态 | 下一步 |\n| --- | --- | --- |\n| 产品说明 | 已审阅 | 确认措辞 |\n| 页面原型 | 待确认 | 查看手机布局 |\n| 数据表格 | 已核对 | 选择分享文件 |\n\n## 接下来\n\n确认这一版后，把选定的文件分享给评审者。\n' if zh else '# Make the work ready to share\n\nReview the changes, then share the selected files. All content here is synthetic demo data.\n\n## This revision\n\n- Documents and prototypes are organized in file tabs.\n- Versions keep the changes and feedback in context.\n- Share selected work with an access code and expiry.\n\n## Delivery checklist\n\n| Deliverable | Status | Next step |\n| --- | --- | --- |\n| Product brief | Reviewed | Confirm the wording |\n| Page prototype | Needs a decision | Check the mobile layout |\n| Data table | Checked | Select the shared files |\n\n## Next\n\nApprove the revision, then share the selected files with reviewers.\n')
    csv = tmp/'summary.csv';csv.write_text('Deliverable,Status\nProduct brief,Reviewed\nPage prototype,Needs a decision\n')
    publish(tmp, env, 'studio', 'delivery', title, body, extras=[csv])
    publish(tmp, env, 'studio', 'delivery', title, body + ('\n更新：补充交付检查。' if zh else '\nUpdate: added the delivery checklist.'), note='补充交付检查' if zh else 'Added the delivery checklist', extras=[csv])
    question = {'questions':[{'id':'ready','type':'choice','label':'这一版可以交付了吗？' if zh else 'Is this revision ready to share?','options':['可以，分享选定文件' if zh else 'Yes, share the selected files','先调整手机布局' if zh else 'Adjust the mobile layout first'],'required':True}],'submit':'提交' if zh else 'Submit'}
    publish(tmp, env, 'studio', 'decision', '确认交付范围' if zh else 'Confirm the delivery scope', '# '+('确认交付范围' if zh else 'Confirm the delivery scope')+'\n\n```approval\n'+json.dumps(question, ensure_ascii=False)+'\n```', agent='claude')
    publish(tmp, env, 'atlas', 'research', '资料复核与下一步' if zh else 'Research review and next steps', '# '+('资料复核' if zh else 'Research review')+'\n\n'+('阅读来源，记录待确认的事项。' if zh else 'Read the sources and note what still needs a decision.'), agent='claude')
    return env

def capture(lang, browser):
    with tempfile.TemporaryDirectory(prefix='foliopier-readme-') as folder:
        tmp = Path(folder);port=ports();env=setup(tmp,port,lang);base=f'http://127.0.0.1:{port}'
        log = open(tmp/'server.log','w')
        server = subprocess.Popen(['node',str(ROOT/'server.mjs')],cwd=ROOT,env=env,stdout=log,stderr=log)
        try:
            for _ in range(100):
                try:urllib.request.urlopen(base+'/healthz', timeout=.3).close();break
                except OSError:time.sleep(.1)
            else:raise RuntimeError((tmp/'server.log').read_text())
            context=browser.new_context(viewport={'width':1280,'height':800},device_scale_factor=1)
            context.add_init_script("localStorage.setItem('mydash.theme','light');localStorage.setItem('mydash.feature.agent-conversations.v1','seen')")
            p=context.new_page();p.goto(base);p.locator('.brand-name').first.wait_for();p.evaluate('document.fonts.ready');p.evaluate('Promise.all(document.getAnimations().map(a=>a.finished))');p.screenshot(path=str(tmp/'desktop.png'))
            assert 'FolioPier AI' in p.title()
            p.locator('.theme-btn').click();p.locator('[data-theme-set="dark"]').click();p.locator('.brand-name').first.wait_for();p.evaluate('document.fonts.ready');p.evaluate('Promise.all(document.getAnimations().map(a=>a.finished))');assert p.locator('html').get_attribute('data-theme') == 'dark';p.screenshot(path=str(OUT/f'{lang}-dark.png'))
            mobile=browser.new_context(viewport={'width':390,'height':780},device_scale_factor=1,is_mobile=True,has_touch=True)
            mobile.add_init_script("localStorage.setItem('mydash.theme','light');localStorage.setItem('mydash.feature.agent-conversations.v1','seen')")
            m=mobile.new_page();shots=[]
            status={'enabled':True,'phase':'configured','publicUrl':'https://share.example.test:8443','pdfReady':True,'checks':{'installed':True,'loggedIn':True,'funnel':True,'localReady':True},'externalVerified':False,'activeShares':0}
            m.route('**/api/sharing/status',lambda r:r.fulfill(content_type='application/json',body=json.dumps(status)))
            for i,route in enumerate(['/p/studio/delivery','/p/studio/decision','/p/studio/delivery']):
                m.goto(base+route);m.locator('.brand-m .logo').wait_for();m.evaluate('document.fonts.ready')
                if i==2:m.locator('[data-share-open]').click();m.locator('#share-create-form').wait_for()
                m.screenshot(path=str(tmp/f'mobile-{i}.png'));shots.append(tmp/f'mobile-{i}.png')
            art=context.new_page();art.set_viewport_size({'width':1440,'height':880})
            art.set_content('<style>body{margin:0;background:#f5f1eb;font-family:sans-serif}.desktop{position:absolute;left:28px;top:42px;width:1100px;border:1px solid #ddd6cc;border-radius:12px}.phone{position:absolute;right:28px;top:76px;width:335px;border:6px solid #252321;border-radius:28px;box-shadow:0 20px 50px #24170b22}</style><img class="desktop" src="'+uri(tmp/'desktop.png')+'"><img class="phone" src="'+uri(shots[0])+'">')
            art.locator('img').evaluate_all('(xs)=>Promise.all(xs.map(x=>x.decode()))');art.screenshot(path=str(OUT/f'{lang}-hero.png'))
            art.set_viewport_size({'width':1290,'height':860});art.set_content('<style>body{margin:0;padding:24px;box-sizing:border-box;background:#f5f1eb;display:flex;justify-content:space-around;gap:28px}img{width:390px;height:780px;border:1px solid #d7d0c6;border-radius:18px}</style>'+''.join('<img src="'+uri(x)+'">' for x in shots))
            art.locator('img').evaluate_all('(xs)=>Promise.all(xs.map(x=>x.decode()))');art.screenshot(path=str(OUT/f'{lang}-phones.png'))
            # Confirm the longer brand remains inside the viewport on a 320px phone.
            m.set_viewport_size({'width':320,'height':740});m.goto(base+'/settings');assert m.evaluate('document.documentElement.scrollWidth<=innerWidth')
            mobile.close();context.close()
        finally:
            server.terminate()
            try:server.wait(timeout=8)
            except subprocess.TimeoutExpired:server.kill();server.wait()
            log.close()

if __name__=='__main__':
    OUT.mkdir(parents=True,exist_ok=True)
    with sync_playwright() as pw:
        browser=pw.chromium.launch();page=browser.new_page();png_icons(page);page.close()
        for language in ['en','zh']:capture(language,browser)
        browser.close()
    print('Generated icons and synthetic English/Chinese README screenshots.')
