"""Isolated owner/public sharing browser regressions; no real Funnel changes."""
import importlib.util
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import socket
import subprocess
import time
import unittest
import urllib.request

spec=importlib.util.spec_from_file_location('mydash_base_ui',Path(__file__).with_name('ui-review.py'))
base_ui=importlib.util.module_from_spec(spec);spec.loader.exec_module(base_ui)

class SharingUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        f=base_ui.ReviewUI;f.setUpClass();cls.f=f;cls.addClassCleanup(f.doClassCleanups)
        f.server.terminate();f.server.wait(timeout=10)
        # The browser job installs this exact Chromium; do not rely on a host Chrome.
        f.env['MYDASH_PDF_BROWSER']=f.pw.chromium.executable_path
        sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close()
        cls.public=f'http://127.0.0.1:{port}'
        cfg=json.loads((f.home/'config.json').read_text());cfg['sharing']={'enabled':True,'localPort':port,'publicUrl':cls.public}
        (f.home/'config.json').write_text(json.dumps(cfg))
        f.server=subprocess.Popen(['node',str(base_ui.ROOT/'server.mjs')],env=f.env,stdout=f.log,stderr=f.log)
        for _ in range(100):
            try:
                if urllib.request.urlopen(cls.public+'/healthz',timeout=.2).status==200:break
            except OSError:time.sleep(.05)
        else:raise RuntimeError((f.tmp/'server.log').read_text())
        folder=f.tmp/'shared-source';folder.mkdir()
        (folder/'main.md').write_text('# Public report\n\n| Item | Value |\n|---|---|\n|A|1|\n\n![diagram](diagram.svg)\n\n```mermaid\ngraph LR\nA-->B\n```')
        (folder/'result.csv').write_text('Name,Value\nB,2\n')
        (folder/'diagram.svg').write_text('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><rect width="100" height="60" fill="#4964ff"/></svg>')
        (folder/'preview.html').write_text('<h1>Read-only HTML preview</h1><script>document.body.textContent="SHOULD NOT RUN"</script>')
        (folder/'private.json').write_text('{"internal":"NOT_PUBLIC"}')
        cls.source=folder
        f.cli('publish',str(folder),'--main','main.md','--title','Shared report','--force-project','test','--slug','browser-share','--json')

    def setUp(self):
        self.context=self.f.browser.new_context(viewport={'width':1366,'height':900},accept_downloads=True)
        self.page=self.context.new_page();self.errors=[]
        self.page.on('pageerror',lambda e:self.errors.append(str(e)))
        status={'enabled':True,'phase':'configured','publicUrl':self.public,'pdfReady':True,'checks':{'installed':True,'loggedIn':True,'funnel':True,'localReady':True},'externalVerified':False,'activeShares':0}
        self.page.route('**/api/sharing/status',lambda r:r.fulfill(content_type='application/json',body=json.dumps(status)))
        self.page.add_init_script("localStorage.setItem('mydash.feature.agent-conversations.v1','seen')")

    def tearDown(self):
        self.context.close();self.assertEqual(self.errors,[])

    def go_owner(self):
        self.page.goto(self.f.base+'/p/test/browser-share?l=en');self.page.wait_for_function('() => !!window.mydashSetThemeMode')
        self.page.locator('[data-share-open]').click();self.page.locator('[data-share-submit]').wait_for(state='visible')
        self.page.wait_for_function('() => !document.querySelector("[data-share-submit]").disabled')

    def shot(self,name):
        folder=os.environ.get('MYDASH_UI_SHOTS')
        if folder:Path(folder).mkdir(parents=True,exist_ok=True);self.page.screenshot(path=str(Path(folder)/(name+'.png')),full_page=True)

    def test_real_owner_create_public_unlock_private_feedback_pdf_and_revoke(self):
        self.go_owner();form=self.page.locator('#share-create-form')
        form.locator('input[name=title]').fill('Public delivery report')
        for name in ['result.csv','diagram.svg','preview.html']:form.locator('input[name=files][value="'+name+'"]').check()
        self.page.locator('[data-share-preview]').click();preview=self.page.frame_locator('[data-share-preview-frame]')
        preview.locator('.share-main h1').filter(has_text='Public delivery report').wait_for()
        self.assertEqual(preview.locator('.file-nav a').count(),4)
        preview.locator('.mermaid svg').wait_for(timeout=10000)
        self.page.locator('[data-share-preview-close]').click()
        form.locator('button[type=submit]').click();result=self.page.locator('[data-share-result]');result.wait_for(state='visible')
        url=result.locator('a').first.get_attribute('href');code=result.locator('code').inner_text();share_id=url.split('/')[-1]
        self.assertEqual(len(code),8);self.page.locator('[data-share-close]').click()
        guest=self.f.browser.new_context(viewport={'width':390,'height':844},accept_downloads=True)
        self.addCleanup(guest.close);p=guest.new_page();p.on('pageerror',lambda e:self.errors.append(str(e)))
        p.goto(url);self.assertNotIn('Public delivery report',p.content());p.locator('#share-code').fill(code);p.locator('[data-share-unlock] button').click()
        p.locator('.share-main h1').filter(has_text='Public delivery report').wait_for()
        p.locator('.share-document img').wait_for();p.wait_for_function('() => document.querySelector(".share-document img").naturalWidth>0')
        p.locator('.share-document img').click();p.locator('.share-image-dialog[open] img').wait_for();p.locator('.share-image-dialog button').click()
        p.locator('.mermaid svg').wait_for(timeout=10000)
        self.assertEqual(p.locator('.tabs a').count(),4);self.assertNotIn('private.json',p.content());self.assertNotIn('NOT_PUBLIC',p.content())
        p.locator('.tabs a').filter(has_text='result.csv').click();p.locator('.share-document table.data td').filter(has_text='B').wait_for()
        p.locator('[data-share-comment] textarea').fill('CSV: please check row B.');p.locator('[data-share-comment] button').click();p.locator('[data-share-status]').filter(has_text='Your comment was sent.').wait_for()
        p.locator('.tabs a').filter(has_text='preview.html').click();frame=p.frame_locator('.share-web-preview');frame.locator('h1').filter(has_text='Read-only HTML preview').wait_for();self.assertNotIn('SHOULD NOT RUN',frame.locator('body').inner_text())
        p.locator('.tabs a').filter(has_text='main.md').click()
        with p.expect_download(timeout=30000) as download:p.locator('[data-share-pdf]').click()
        self.assertTrue(Path(download.value.path()).read_bytes().startswith(b'%PDF-'))
        pdf_bytes=Path(download.value.path()).read_bytes()
        (self.source/'native.pdf').write_bytes(pdf_bytes)
        self.f.cli('publish',str(self.source),'--main','main.md','--title','Shared report','--force-project','test','--slug','browser-share','--json')
        pdf_share=self.f.post('/api/shares',{'project':'test','slug':'browser-share','main':'main.md','files':['main.md','native.pdf'],'title':'PDF preview','version':2})
        pdf_guest=self.f.browser.new_context(viewport={'width':390,'height':844});self.addCleanup(pdf_guest.close);pdf_page=pdf_guest.new_page()
        pdf_page.goto(pdf_share['url']+'?f=native.pdf');pdf_page.locator('#share-code').fill(pdf_share['code']);pdf_page.locator('[data-share-unlock] button').click();pdf_page.locator('.pdf-view canvas').first.wait_for(timeout=15000)
        self.page.goto(self.f.base+'/p/test/browser-share?l=en');self.page.locator('[data-share-open]').click();self.page.locator('#share-create-form [name=files][value="native.pdf"]').check();self.page.locator('[data-share-preview]').click()
        pdf_preview=self.page.frame_locator('[data-share-preview-frame]');pdf_preview.locator('.tabs a').filter(has_text='native.pdf').click();pdf_preview.locator('.pdf-view canvas').first.wait_for(timeout=15000)
        self.page.locator('[data-share-preview-close]').click();self.page.locator('[data-share-close]').click()
        if os.environ.get('MYDASH_UI_SHOTS'):p.screenshot(path=str(Path(os.environ['MYDASH_UI_SHOTS'])/'public-reader-mobile.png'),full_page=True)
        self.page.locator('[data-share-open]').click();self.page.locator('[data-share-tab=manage]').click();card=self.page.locator('[data-share-id="'+share_id+'"]')
        card.get_by_text('CSV: please check row B.',exact=True).wait_for(state='attached');self.assertIn('result.csv',card.inner_text())
        card.locator('[data-share-action=revoke]').click();self.page.locator('[data-share-confirm-accept]').click()
        p.reload();p.get_by_role('heading',name='This share is no longer available.').wait_for()

    def test_extending_expiry_keeps_an_open_visitor_and_renews_its_session(self):
        original=(datetime.now(timezone.utc)+timedelta(seconds=13)).isoformat()
        made=self.f.post('/api/shares',{'project':'test','slug':'browser-share','main':'main.md','files':['main.md'],'title':'Expiry extension','expiresAt':original})
        guest=self.f.browser.new_context(viewport={'width':390,'height':844});self.addCleanup(guest.close);p=guest.new_page()
        p.goto(made['url']);p.locator('#share-code').fill(made['code'])
        with p.expect_response(lambda r:r.url.endswith('/status')):p.locator('[data-share-unlock] button').click()
        p.locator('[data-share-countdown]').wait_for(state='visible')
        p.wait_for_timeout(9500)
        updated=self.f.post('/api/shares/'+made['share']['id'],{'action':'update','expiresInHours':1})['share']['expiresAt']
        p.wait_for_function('(expected) => window.__SHARE.expiresAt === expected',arg=updated,timeout=10000)
        p.wait_for_timeout(2000)
        self.assertTrue(p.locator('.share-main > header h1').is_visible())
        self.assertEqual(p.evaluate('(url) => fetch(url).then(r => r.status)',made['url']+'/status'),200)

    def test_guidance_return_preserves_selected_files_and_draft(self):
        self.go_owner();form=self.page.locator('#share-create-form');form.locator('[name=title]').fill('Keep this draft');form.locator('[name=files][value="result.csv"]').check()
        self.page.route('**/api/sharing/status',lambda r:r.fulfill(content_type='application/json',body=json.dumps({'enabled':False,'phase':'off','checks':{},'pdfReady':False})))
        self.page.locator('[data-share-close]').click();self.page.locator('[data-share-open]').click();self.page.locator('[data-share-setup-link]').first.click()
        self.page.locator('#internet-sharing').wait_for();back=self.page.locator('[data-sharing-return]');back.click()
        self.page.locator('#share-owner-dialog').wait_for();self.assertEqual(self.page.locator('#share-create-form [name=title]').input_value(),'Keep this draft');self.assertTrue(self.page.locator('#share-create-form [name=files][value="result.csv"]').is_checked())

if __name__=='__main__':unittest.main(verbosity=2)
