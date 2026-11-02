"""Browser regressions, isolated data and server; requires Python Playwright + Chromium.
Run: python test/ui-review.py (screenshots: MYDASH_UI_SHOTS=/tmp/mydash-ui-shots).
No changes to an existing installation; no external notification services used.
"""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent


class ReviewUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='mydash-review-ui-'))
        cls.home = cls.tmp / 'home'
        cls.home.mkdir()
        # Reserve both candidate ports before starting the two-port server.
        while True:
            a = socket.socket(); a.bind(('127.0.0.1', 0)); port = a.getsockname()[1]
            b = socket.socket()
            try:
                b.bind(('127.0.0.1', port + 1))
                break
            except OSError:
                a.close(); b.close()
        a.close(); b.close()
        cls.base = 'http://127.0.0.1:' + str(port)
        cls.env = {**os.environ, 'MYDASH_HOME': str(cls.home), 'MYDASH_LANG': 'en',
                   'MYDASH_CODEX_HOME': str(cls.tmp / 'codex'), 'MYDASH_CLAUDE_HOME': str(cls.tmp / 'claude')}
        for key in ['MYDASH_DATA', 'MYDASH_PORT', 'MYDASH_CONTENT_PORT', 'MYDASH_BASE_URL', 'MYDASH_REMOTE',
                    'MYDASH_TOKEN', 'CODEX_THREAD_ID', 'CLAUDE_CODE_SESSION_ID', 'MYDASH_PROJECT']:
            cls.env.pop(key, None)
        (cls.home / 'config.json').write_text(json.dumps({'port': port, 'contentPort': port + 1,
            'baseUrl': cls.base, 'lang': 'en', 'access': 'local', 'update': {'mode': 'off'},
            'prompts': {'pushDelay': -1}}))
        cls.publish('search-report', '# Search report\n\n' + 'Opening context. ' * 40 + '\n\nsea-stone', 'report', 'alpha')
        cls.publish('search-plan', '# Search plan\n\n' + 'Opening context. ' * 40 + '\n\nsea-stone', 'plan', 'beta', agent='claude')
        cls.log = open(cls.tmp / 'server.log', 'w')
        cls.server = subprocess.Popen(['node', str(ROOT / 'server.mjs')], env=cls.env, stdout=cls.log, stderr=cls.log)
        cls.addClassCleanup(cls.cleanup)
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.base + '/healthz', timeout=.3).close()
                break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError((cls.tmp / 'server.log').read_text())
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch(headless=True)

    @classmethod
    def cleanup(cls):
        if hasattr(cls, 'browser'): cls.browser.close()
        if hasattr(cls, 'pw'): cls.pw.stop()
        cls.server.terminate()
        try: cls.server.wait(timeout=10)
        except subprocess.TimeoutExpired: cls.server.kill(); cls.server.wait(timeout=5)
        cls.log.close()
        shutil.rmtree(cls.tmp)

    @classmethod
    def cli(cls, *args, env=None):
        r = subprocess.run(['node', str(ROOT / 'bin/mydash.mjs'), *args], env=env or cls.env, cwd=ROOT,
                           capture_output=True, text=True, timeout=30)
        if r.returncode: raise RuntimeError(r.stdout + r.stderr)
        return json.loads(r.stdout.strip().splitlines()[-1]) if '--json' in args else r.stdout

    @classmethod
    def publish(cls, slug, text, kind='report', project='test', agent='codex'):
        source = cls.tmp / (slug + '.md'); source.write_text(text)
        return cls.cli('publish', str(source), '--force-project', project, '--slug', slug, '--type', kind, '--json', env={**cls.env, 'MYDASH_AGENT': agent})

    @classmethod
    def post(cls, path, data):
        req = urllib.request.Request(cls.base + path, data=json.dumps(data).encode(),
            headers={'Content-Type': 'application/json', 'X-Mydash': '1'})
        return json.load(urllib.request.urlopen(req, timeout=5))

    def setUp(self):
        self.context = self.browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True, reduced_motion='reduce')
        self.context.add_init_script("localStorage.setItem('mydash.theme', 'light')")
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append(str(e)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def go(self, route):
        self.page.goto(self.base + route, wait_until='domcontentloaded')
        self.page.wait_for_function('() => !!window.mydashSetThemeMode')
        try: self.page.wait_for_load_state('networkidle', timeout=1000)
        except Exception: pass  # The EventSource can remain open.
        self.page.evaluate('document.fonts.ready')

    def shot(self, name):
        folder = os.environ.get('MYDASH_UI_SHOTS')
        if folder:
            Path(folder).mkdir(parents=True, exist_ok=True)
            self.page.screenshot(path=str(Path(folder) / (name + '.png')), full_page=True)

    @staticmethod
    def approval(label='Publish?', qid='go', kind='choice'):
        q = {'id': qid, 'label': label, 'type': kind, 'required': True}
        if kind == 'choice': q['options'] = ['Yes', 'No']
        return '```approval\n' + json.dumps({'questions': [q]}) + '\n```'

    def header_fixture(self, slug):
        source = self.tmp / (slug + '.md')
        source.write_text('# Clear item header\n\n' + '\n\n'.join(['Reading content.'] * 20))
        files = [source]
        for i in range(11):
            f = self.tmp / ((('long-original-filename-' * 7) if i == 0 else 'attachment-') + str(i) + '.csv')
            f.write_text('name,value\nExample,1\n'); files.append(f)
        for version in [1, 2]:
            self.cli('publish', *map(str, files), '--force-project', 'test', '--slug', slug,
                     '--type', 'report', '--title', 'Clear item header', '--note', 'Revision ' + str(version),
                     '--json', env={**self.env, 'MYDASH_AGENT': 'codex'})

    def test_header_controls_stay_in_place_when_expanded(self):
        self.header_fixture('header-stable')
        for lang in ['en', 'zh']:
            for width in [320, 390, 1280]:
                with self.subTest(lang=lang, width=width):
                    self.page.set_viewport_size({'width': width, 'height': 900})
                    self.go('/p/test/header-stable?l=' + lang)
                    self.assertEqual(self.page.locator('.more-btn').is_visible(), width < 960)
                    buttons = self.page.locator('.doc-detail-toggle')
                    self.assertEqual(buttons.count(), 3)
                    before = [b.bounding_box() for b in buttons.all()]
                    for i, button in enumerate(buttons.all()):
                        box = before[i]; x = box['x'] + box['width'] / 2; y = box['y'] + box['height'] / 2
                        self.page.mouse.click(x, y)
                        self.assertEqual(button.get_attribute('aria-expanded'), 'true')
                        panel = self.page.locator('#' + button.get_attribute('aria-controls'))
                        self.assertTrue(panel.is_visible())
                        after = [b.bounding_box() for b in buttons.all()]
                        for a, b in zip(before, after):
                            self.assertAlmostEqual(a['x'], b['x'], delta=.5)
                            self.assertAlmostEqual(a['y'], b['y'], delta=.5)
                        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), width)
                        # A second click at exactly the same screen position collapses it.
                        self.page.mouse.click(x, y)
                        self.assertEqual(button.get_attribute('aria-expanded'), 'false')
                        self.assertFalse(panel.is_visible())
                    self.shot('header-' + lang + '-' + str(width))

    def test_header_details_keyboard_and_old_version(self):
        self.header_fixture('header-keyboard'); self.go('/p/test/header-keyboard')
        self.assertIn('Publishing tool', self.page.locator('.doc-meta').inner_text())
        self.assertNotIn('Report', self.page.locator('.doc-meta').inner_text())
        versions = self.page.get_by_role('button', name='Version history 2')
        files = self.page.get_by_role('button', name='File list 12')
        publication = self.page.get_by_role('button', name='Publication details', exact=True)
        versions.focus(); self.page.keyboard.press('Enter')
        self.assertTrue(self.page.locator('#detail-versions').is_visible())
        self.assertEqual(self.page.locator('#detail-versions .on b').inner_text(), 'v2')
        self.assertLess(self.page.locator('#detail-versions .vd').bounding_box()['width'], 100)
        files.focus(); self.page.keyboard.press('Space')
        self.assertTrue(self.page.locator('#detail-versions').is_hidden())
        self.assertEqual(self.page.locator('#detail-files li').count(), 12)
        publication.click()
        self.assertTrue(self.page.locator('#detail-files').is_hidden())
        self.assertIn('Content type', self.page.locator('#detail-publication').inner_text())
        self.assertIn('Original paths', self.page.locator('#detail-publication').inner_text())
        self.page.keyboard.press('Tab')
        self.assertTrue(self.page.locator('#detail-publication').evaluate('(el) => el === document.activeElement'))
        self.page.keyboard.press('ArrowDown')
        self.page.wait_for_function('() => document.querySelector("#detail-publication").scrollTop > 0')
        self.shot('header-publication-mobile')
        self.page.keyboard.press('Escape')
        self.assertTrue(self.page.locator('#detail-publication').is_hidden())
        self.assertTrue(publication.evaluate('(el) => el === document.activeElement'))
        self.go('/p/test/header-keyboard?v=1')
        self.assertEqual(self.page.locator('#detail-toggle-versions').get_attribute('aria-expanded'), 'true')
        self.assertEqual(self.page.locator('#detail-versions .on b').inner_text(), 'v1')
        self.page.locator('#detail-versions a').filter(has_text='v2').first.click()
        self.page.wait_for_url('**/p/test/header-keyboard')
        self.assertEqual(self.page.locator('.ver-badge').inner_text(), 'v2')
        self.page.emulate_media(media='print')
        self.assertTrue(self.page.locator('.doc-inspector').is_hidden())

    def test_approval_blocks_keep_independent_answers(self):
        self.publish('multi', self.approval() + '\n\n' + self.approval('Keep the old version?'), 'approval')
        self.go('/p/test/multi')
        self.page.locator('.ap-q').nth(0).locator('label.ap-opt').first.click()
        self.page.locator('.ap-q').nth(1).locator('label.ap-opt').nth(1).click()
        self.assertEqual(self.page.locator('.ap-q input[type=radio]:checked').count(), 2)
        self.page.locator('.ap-send').click()
        self.assertEqual(self.page.locator('dialog .ap-review li span').all_text_contents(), ['Yes', 'No'])
        with self.page.expect_response('**/api/approval') as response:
            self.page.locator('dialog .ap-confirm').click()
        self.assertEqual(response.value.status, 200)
        self.shot('approval-mobile')

    def test_double_click_is_one_submission(self):
        self.publish('double', self.approval(), 'approval'); self.go('/p/test/double')
        self.page.locator('.ap-q label.ap-opt').first.click(); self.page.locator('.ap-send').click()
        calls = []
        def slow(route):
            calls.append(route.request.post_data); time.sleep(.3); route.continue_()
        self.page.route('**/api/approval', slow)
        self.page.locator('dialog .ap-confirm').dblclick(delay=30)
        self.page.wait_for_function('() => document.querySelector("#ap-form").classList.contains("locked")')
        r = json.loads((self.home / 'data/test/double/responses.json').read_text())
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(r['approvals']), 1)

    def test_retry_after_unreadable_response_keeps_one_answer(self):
        self.publish('retry', self.approval(), 'approval'); self.go('/p/test/retry')
        self.page.locator('.ap-q label.ap-opt').first.click(); self.page.locator('.ap-send').click()
        calls = []
        def lose_response(route):
            calls.append(route.request.post_data)
            if len(calls) == 1:
                response = route.fetch()  # The server saved it, but the browser cannot read this response.
                route.fulfill(response=response, body='invalid JSON')
            else:
                route.continue_()
        self.page.route('**/api/approval', lose_response)
        self.page.locator('dialog .ap-confirm').click(); self.page.wait_for_timeout(300)
        self.assertEqual(self.page.locator('dialog .ap-confirm').count(), 1)
        self.page.locator('dialog .ap-confirm').click()
        self.page.wait_for_function('() => document.querySelector("#ap-form").classList.contains("locked")')
        r = json.loads((self.home / 'data/test/retry/responses.json').read_text())
        self.assertEqual(len(calls), 2); self.assertEqual(len(r['approvals']), 1)

    def test_editing_a_submitted_approval_restores_its_draft(self):
        self.publish('edit-draft', self.approval(), 'approval')
        self.post('/api/approval', {'id': 'test/edit-draft', 'v': 1, 'answers': {'go': 'Yes'}})
        self.go('/p/test/edit-draft')
        self.page.locator('.ap-edit').click(); self.page.locator('.ap-q label.ap-opt').nth(1).click()
        self.page.once('dialog', lambda d: d.accept()); self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('() => !!window.mydashSetThemeMode')
        self.assertEqual(self.page.locator('.ap-q input:checked').input_value(), 'No')
        self.assertFalse(self.page.locator('.ap-q input:checked').is_disabled())

    def test_missing_answer_gets_focus_and_an_inline_error(self):
        self.publish('missing', self.approval('Explanation', kind='text'), 'approval'); self.go('/p/test/missing')
        self.page.locator('.ap-send').click()
        field = self.page.get_by_role('textbox', name='Explanation')
        self.assertEqual(field.get_attribute('aria-invalid'), 'true')
        self.assertTrue(self.page.evaluate('document.activeElement.tagName === "TEXTAREA"'))
        self.assertTrue(self.page.locator('.ap-field-error').is_visible())
        field.fill('The explanation')
        self.assertIsNone(field.get_attribute('aria-invalid'))

    def test_new_version_preserves_comment_and_its_version(self):
        self.publish('draft', '# Report\n\nThe old content.'); self.go('/p/test/draft')
        self.page.locator('.cm-add').click(); self.page.locator('.cm-text').fill('A draft about v1')
        self.publish('draft', '# Report\n\nThe new content.')
        self.page.wait_for_timeout(1200)
        self.assertEqual(self.page.locator('.cm-text').input_value(), 'A draft about v1')
        self.assertEqual(self.page.locator('body').get_attribute('data-version'), '1')
        self.assertTrue(self.page.locator('.version-update').is_visible())
        self.page.locator('dialog .ap-confirm').click()
        self.page.wait_for_function('() => !document.querySelector("dialog")')
        r = json.loads((self.home / 'data/test/draft/responses.json').read_text())
        self.assertEqual(r['comments'][-1]['v'], 1)
        self.assertEqual(r['comments'][-1]['text'], 'A draft about v1')
        self.shot('new-version-draft')

    def test_comment_draft_survives_reload(self):
        self.publish('restore-draft', '# Report\n\nContent.'); self.go('/p/test/restore-draft')
        self.page.locator('.cm-add').click(); self.page.locator('.cm-text').fill('Keep this draft')
        self.page.once('dialog', lambda d: d.accept())
        self.page.reload(wait_until='domcontentloaded'); self.page.wait_for_function('() => !!window.mydashSetThemeMode')
        self.page.locator('.cm-add').click()
        self.assertEqual(self.page.locator('.cm-text').input_value(), 'Keep this draft')

    def test_closed_approval_updates_open_page(self):
        self.publish('close', self.approval(), 'approval'); self.go('/p/test/close')
        self.cli('approvals', 'close', 'test/close', '--note', 'Decided in chat', '--json')
        self.page.wait_for_function('() => document.querySelector(".ap-q input").disabled', timeout=5000)
        self.assertIn('Decided in chat', self.page.locator('.ap-state').inner_text())

    def test_full_text_results_obey_current_filters(self):
        self.go('/'); self.page.locator('.filter-btn').click()
        self.page.locator('.cat-seg [data-cat=report]').click()
        self.page.locator('#q').fill('sea-stone')
        self.page.wait_for_selector('.ft-results a')
        self.assertEqual(self.page.locator('.ft-results a').evaluate_all('(es)=>es.map(e=>e.getAttribute("href"))'),
                         ['/p/alpha/search-report'])
        # Changing the filter must recalculate already displayed full-text results.
        self.page.locator('.cat-seg [data-cat=plan]').click()
        self.page.wait_for_function('() => document.querySelector(".ft-results a")?.getAttribute("href")==="/p/beta/search-plan"')
        self.shot('filtered-search')

    def test_search_composes_agent_unread_and_archive_filters(self):
        def search(params):
            return json.load(urllib.request.urlopen(self.base + '/api/search?q=sea-stone&scope=list&' + params))
        self.post('/api/read', {'id': 'alpha/search-report', 'v': 1})
        self.post('/api/read', {'id': 'beta/search-plan', 'unread': True})
        self.assertEqual([r['id'] for r in search('agent=claude&show=unread')], ['beta/search-plan'])
        self.assertEqual(search('agent=codex&show=unread'), [])
        self.post('/api/archive', {'id': 'beta/search-plan', 'archived': True})
        try:
            self.assertEqual([r['id'] for r in search('')], ['alpha/search-report'])
            self.assertEqual([r['id'] for r in search('archived=1')], ['beta/search-plan'])
        finally:
            self.post('/api/archive', {'id': 'beta/search-plan', 'archived': False})

    def test_handled_approval_updates_open_page(self):
        self.publish('handled', self.approval(), 'approval')
        answer = self.post('/api/approval', {'id': 'test/handled', 'v': 1, 'answers': {'go': 'Yes'}, 'requestId': 'handled-confirmation'})
        self.go('/p/test/handled')
        self.cli('approvals', 'done', answer['submission']['id'], '--json')
        self.page.wait_for_function('() => document.querySelector(".ap-state").innerText.includes("Your agent has handled this.")')

    def test_read_event_does_not_steal_search_focus(self):
        self.post('/api/read', {'id': 'alpha/search-report', 'v': 1})
        self.go('/'); self.page.locator('#q').fill('search'); self.page.locator('#q').focus()
        result = self.post('/api/read', {'id': 'alpha/search-report', 'unread': True})
        self.assertTrue(result['changed']); self.page.wait_for_timeout(800)
        self.assertEqual(self.page.evaluate('document.activeElement.id'), 'q')
        self.assertEqual(self.page.locator('#q').input_value(), 'search')

    def test_mobile_project_sheet_keeps_focus_inside(self):
        self.go('/'); self.page.locator('.tb-proj').click()
        self.page.wait_for_function('() => !!document.activeElement.closest("#side")')
        for _ in range(12):
            self.page.keyboard.press('Tab')
            self.assertTrue(self.page.evaluate('!!document.activeElement.closest("#side")'))
        self.assertEqual(self.page.locator('#side').get_attribute('aria-modal'), 'true')
        self.page.keyboard.press('Escape')
        self.assertEqual(self.page.evaluate('document.activeElement.className'), 'tb-item tb-proj')
        self.assertIsNone(self.page.locator('.col').get_attribute('inert'))

    def test_semantic_controls_are_named(self):
        self.publish('named', self.approval('Explanation', kind='text'), 'approval'); self.go('/p/test/named')
        self.assertEqual(self.page.get_by_role('textbox', name='Explanation').count(), 1)
        self.publish('named-todo', '# To-do\n\n- [ ] One thing', 'todo'); self.go('/p/test/named-todo')
        self.assertEqual(self.page.get_by_role('progressbar', name='To-do progress').count(), 1)
        self.go('/settings')
        self.assertEqual(self.page.get_by_label('Daily summary time', exact=True).count(), 1)

    def test_notification_password_is_masked_and_can_be_shown(self):
        self.go('/settings'); self.page.locator('#set-push summary').first.click()
        self.page.locator('.set-add').click(); self.page.locator('.set-type[data-type=email]').click()
        field = self.page.locator('#set-ed [name=pass]'); field.fill('example-only-password')
        self.assertEqual(field.get_attribute('type'), 'password')
        self.page.get_by_role('button', name='Show password', exact=True).click()
        self.assertEqual(field.get_attribute('type'), 'text')
        self.page.get_by_role('button', name='Hide password', exact=True).click()
        self.assertEqual(field.get_attribute('type'), 'password')
        self.assertIn('Not saved', self.page.locator('.set-ed-state').inner_text())
        self.assertIn('Add or Save', self.page.locator('.page-sub').inner_text())
        self.assertLessEqual(self.page.evaluate('document.documentElement.scrollWidth'), 390)
        self.shot('settings-password')

    def test_waiting_queue_is_collapsible_and_remembers_choice(self):
        for i in range(7):
            self.post('/api/prompts', {'tool': 'cli', 'kind': 'question', 'project': 'test',
                'payload': {'questions': [{'question': 'Waiting ' + str(i), 'options': ['Yes', 'No']}]}})
        self.go('/')
        self.assertLessEqual(self.page.locator('.ap-row:visible').count(), 3)
        self.assertGreater(self.page.locator('.ap-row').count(), 3)
        self.page.locator('#waiting-more > summary').click()
        self.assertGreater(self.page.locator('.ap-row:visible').count(), 3)
        self.page.reload(wait_until='domcontentloaded')
        self.page.wait_for_function('() => document.querySelector("#waiting-more").open')
        self.page.locator('#waiting-more > summary').click(); self.shot('waiting-mobile')

    def test_update_from_the_top_bar_shows_progress_and_reloads(self):
        config_path, state = self.home / 'config.json', self.home / 'state' / 'update.json'
        config = config_path.read_text()
        state.parent.mkdir(exist_ok=True)
        try:
            config_path.write_text(json.dumps({**json.loads(config), 'update': {'mode': 'notify'},
                'source': str(self.tmp / 'no-source'), 'sourceRemote': 'https://example.invalid/mydash.git'}))
            state.write_text(json.dumps({'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
                'latest': {'version': '99.0.0', 'tag': 'v99.0.0', 'url': None}}))
            # 不真的更新：模拟更新进程依次走过几个阶段、服务重启时断一下、最后装好
            base = {'current': '0.0.1', 'latest': {'version': '99.0.0', 'tag': 'v99.0.0', 'url': None}, 'available': True,
                    'mode': 'notify', 'canCheck': True, 'canUpdate': True, 'running': None, 'last': None}
            steps = ['fetch', 'deps', 'install', 'down', 'done']
            posted = []
            def answer(route):
                if route.request.method == 'POST':
                    posted.append(json.loads(route.request.post_data)['action'])
                    return route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
                if 'start' not in posted:
                    return route.fulfill(status=200, content_type='application/json', body=json.dumps(base))
                step = steps.pop(0) if len(steps) > 1 else steps[0]
                if step == 'down': return route.abort('connectionrefused')
                if step == 'done':
                    body = {**base, 'available': False, 'last': {'ok': True, 'at': '2030-01-01T00:00:00Z', 'to': '99.0.0', 'human': [], 'url': None, 'seen': False}}
                else:
                    body = {**base, 'running': {'pid': 1, 'startedAt': '2030-01-01T00:00:00Z', 'stage': step}}
                return route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
            self.page.route('**/api/update', answer)
            self.go('/settings'); self.assertEqual(self.page.locator('.upd-top').count(), 1)
            self.go('/')
            self.publish('arrives-live', '# Arrives live\n\nNew while the page is open.')
            self.page.wait_for_selector('.entry[data-id="test/arrives-live"]')
            self.page.locator('.upd-top').click()
            self.page.locator('[data-upd-go]').click()
            self.page.wait_for_selector('.upd-prog[role=progressbar]')
            self.assertIn('running', self.page.locator('.upd-top').get_attribute('class'))
            self.page.wait_for_function('() => Number(document.querySelector(".upd-prog")?.getAttribute("aria-valuenow")) > 10')
            self.page.wait_for_selector('[data-upd-ok]', timeout=20000)
            self.assertIn('99.0.0', self.page.locator('.upd-dlg h3').inner_text())
            with self.page.expect_navigation():
                self.page.locator('[data-upd-ok]').click()
            self.assertEqual(posted, ['start', 'seen'])
        finally:
            config_path.write_text(config); state.unlink(missing_ok=True)

    def test_codex_hooks_are_allowed_from_the_home_page(self):
        codex = Path(self.env['MYDASH_CODEX_HOME']); codex.mkdir(exist_ok=True)
        self.cli('integrate', 'codex')
        try:
            self.go('/')
            card = self.page.locator('[data-setup=codex-trust]')
            self.assertEqual(card.count(), 1)
            card.click()
            self.page.locator('[data-setup-go]').click()
            self.page.wait_for_selector('[data-setup=codex-trust]', state='detached')
            self.assertEqual((codex / 'config.toml').read_text().count('trusted_hash = "sha256:'), 4)
            self.shot('codex-allowed')
        finally:
            self.cli('integrate', 'codex', '--remove')

    def test_boot_setup_waits_for_the_mac_password_prompt(self):
        posted, polls = [], []
        def answer(route):
            if route.request.method == 'POST':
                posted.append(json.loads(route.request.post_data)['action'])
                return route.fulfill(status=200, content_type='application/json', body='{"ok":true}')
            polls.append(1)
            if len(polls) == 1: return route.fulfill(status=200, content_type='application/json', body=json.dumps({'codexTrust': 0, 'boot': {'pending': True, 'running': True, 'last': None}}))
            if len(polls) == 2: return route.abort('connectionrefused')  # 换成开机启动时服务重启了一下
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({'codexTrust': 0, 'boot': {'pending': False, 'running': False, 'last': {'ok': True}}}))
        self.page.route('**/api/setup', answer)
        self.go('/')
        # 卡片要在装成开机启动、还没做管理员那一步时才出现；这里直接放一个按钮，看弹窗的流程
        self.page.evaluate("document.querySelector('#main').insertAdjacentHTML('afterbegin', '<button type=button data-setup=boot>boot</button>')")
        self.page.locator('[data-setup=boot]').click()
        self.assertIn('password', self.page.locator('.upd-dlg').inner_text())
        self.page.locator('[data-setup-go]').click()
        self.page.wait_for_selector('.upd-dlg.upd-ok', timeout=15000)
        self.assertEqual(posted, ['boot'])
        with self.page.expect_navigation():
            self.page.locator('.upd-dlg [data-close]').click()

    def test_semantic_text_contrast_in_both_themes(self):
        self.publish('color-approval', self.approval(), 'approval'); self.go('/')
        contrast = '''([selector,rootBg])=>{const e=document.querySelector(selector),s=getComputedStyle(e),root=getComputedStyle(document.documentElement);
          const ctx=document.createElement('canvas').getContext('2d');const rgb=color=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=color;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
          const lum=c=>rgb(c).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
          const a=lum(s.color),b=lum(rootBg?root.getPropertyValue('--bg'):s.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)}'''
        for theme in ['light', 'dark']:
            self.page.evaluate("window.mydashSetThemeMode('" + theme + "')")
            self.page.wait_for_timeout(150)
            for selector, root_bg in [('a[href$="/color-approval"] .ap-go', False), ('.hl', True), ('.tb-badge', False)]:
                self.assertGreaterEqual(self.page.evaluate(contrast, [selector, root_bg]), 4.5, theme + ' ' + selector)
        self.shot('home-dark')


if __name__ == '__main__':
    unittest.main(verbosity=2)
