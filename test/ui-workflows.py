"""Exercise delivery packages and version comparisons on an isolated install."""
import importlib.util
import json
from pathlib import Path
import socket
import subprocess
import time
import unittest
import urllib.request
from playwright.sync_api import expect

spec = importlib.util.spec_from_file_location('review_ui', Path(__file__).with_name('ui-review.py'))
base_ui = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base_ui)


def pdf_fixture(pages):
    """Write a tiny PDF with a rectangle on each page."""
    children = ' '.join(f'{3 + n} 0 R' for n in range(pages))
    objects = ['<< /Type /Catalog /Pages 2 0 R >>', f'<< /Type /Pages /Kids [{children}] /Count {pages} >>']
    for n in range(pages):
        objects.append(f'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 180] /Contents {3 + pages + n} 0 R >>')
    for n in range(pages):
        drawing = f'0.2 0.4 0.9 rg 10 10 {50 + n * 20} 70 re f'
        objects.append(f'<< /Length {len(drawing)} >>\nstream\n{drawing}\nendstream')
    data = b'%PDF-1.4\n'
    offsets = []
    for index, value in enumerate(objects, start=1):
        offsets.append(len(data))
        data += f'{index} 0 obj\n{value}\nendobj\n'.encode()
    xref = len(data)
    data += f'xref\n0 {len(objects) + 1}\n0000000000 65535 f \n'.encode()
    for offset in offsets:
        data += f'{offset:010d} 00000 n \n'.encode()
    return data + f'trailer << /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode()


class WorkflowUI(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = base_ui.ReviewUI
        cls.fixture.setUpClass()
        cls.addClassCleanup(cls.fixture.doClassCleanups)
        f = cls.fixture
        f.server.terminate()
        f.server.wait(timeout=10)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.public = f'http://127.0.0.1:{port}'
        config = json.loads((f.home / 'config.json').read_text())
        config['sharing'] = {'enabled': True, 'localPort': port, 'publicUrl': cls.public}
        (f.home / 'config.json').write_text(json.dumps(config))
        f.server = subprocess.Popen(['node', str(base_ui.ROOT / 'server.mjs')], env=f.env, stdout=f.log, stderr=f.log)
        for _ in range(100):
            try:
                urllib.request.urlopen(cls.public + '/healthz', timeout=.3).close()
                break
            except OSError:
                time.sleep(.05)
        else:
            raise RuntimeError((f.tmp / 'server.log').read_text())
        cls.base = f.base
        f.publish('package-first', '# First report\n\nFirst edition.')
        f.publish('package-second', '# Second report\n\nSecond sample.')
        table = f.tmp / 'rows.csv'
        table.write_text('id,value\n001,Before\n003,Removed\n')
        f.cli('publish', str(table), '--force-project', 'test', '--slug', 'review-table', '--json')
        table.write_text('id,value\n004,Added\n001,After\n')
        f.cli('publish', str(table), '--force-project', 'test', '--slug', 'review-table', '--json')

    def setUp(self):
        self.context = self.fixture.browser.new_context(viewport={'width': 390, 'height': 844},
            is_mobile=True, has_touch=True, reduced_motion='reduce')
        self.context.add_init_script("localStorage.setItem('mydash.feature.agent-conversations.v1','seen')")
        self.context.set_default_timeout(10000)
        self.page = self.context.new_page()
        self.errors = []
        self.page.on('pageerror', lambda error: self.errors.append(str(error)))

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def go(self, route):
        response = self.page.goto(self.base + route, wait_until='domcontentloaded')
        self.assertEqual(response.status, 200)
        self.page.wait_for_function('() => !!window.mydashSetThemeMode')

    def action_in_more(self, name):
        choice = self.page.get_by_role('link', name=name)
        if not choice.is_visible():
            self.page.locator('.more-btn').click()
        choice.click()

    def test_package_owner_preview_and_mobile_visitor(self):
        self.page.set_viewport_size({'width': 1320, 'height': 900})
        self.go('/p/test')
        self.page.get_by_role('link', name='Delivery packages').click()
        self.page.get_by_label('Title').fill('Customer handoff')
        for slug in ['package-first', 'package-second']:
            self.page.get_by_label('Choose a document').select_option(slug)
            self.page.get_by_role('button', name='Add document', exact=True).click()
        self.page.get_by_role('button', name='Preview as a visitor').click()
        preview_link = self.page.get_by_role('link', name='Open visitor preview')
        preview_link.wait_for()
        preview = self.context.new_page()
        preview.goto(self.base + preview_link.get_attribute('href'))
        preview.get_by_text('Approved resources').first.wait_for()
        preview.locator('.package-directory > li > p a').first.click()
        preview.get_by_text('First edition.').wait_for()
        preview.close()
        self.page.get_by_role('button', name='Publish this revision').click()
        result = self.page.locator('[data-package-result]')
        code = result.locator('code').inner_text()
        target = result.locator('a').first.get_attribute('href')
        visitor = self.context.new_page()
        visitor.set_viewport_size({'width': 390, 'height': 844})
        visitor.goto(target)
        visitor.get_by_label('Access code').fill(code)
        visitor.get_by_role('button', name='View document').click()
        visitor.locator('.package-directory > li > p a').first.click()
        visitor.get_by_text('First edition.').wait_for()
        visitor.get_by_role('link', name='Next document').click()
        visitor.get_by_text('Second sample.').wait_for()
        self.assertLessEqual(visitor.evaluate('document.documentElement.scrollWidth'), 390)
        result.get_by_role('link', name='Manage delivery package').click()
        self.page.on('dialog', lambda d: d.accept())
        self.page.get_by_role('button', name='Revoke link').click()
        self.page.get_by_text('This share is no longer available.').wait_for()
        self.assertEqual(visitor.reload().status, 410)

    def test_package_preview_arriving_after_removal_cannot_be_published(self):
        self.go('/p/test')
        self.page.get_by_role('link', name='Delivery packages').click()
        self.page.get_by_label('Title').fill('Edited handoff')
        for slug in ['package-first', 'package-second']:
            self.page.get_by_label('Choose a document').select_option(slug)
            self.page.get_by_role('button', name='Add document', exact=True).click()
        held = []
        self.page.route('**/api/workflow/packages', lambda route: held.append(route))
        preview = self.page.get_by_role('button', name='Preview as a visitor')
        preview.click()
        self.page.locator('[data-slug="package-second"]').get_by_role('button', name='Remove').click()
        self.assertEqual(len(held), 1)
        held.pop().continue_()
        self.page.unroute('**/api/workflow/packages')
        expect(preview).to_be_enabled()
        self.assertFalse(self.page.get_by_role('link', name='Open visitor preview').is_visible())
        publish = self.page.get_by_role('button', name='Publish this revision')
        self.assertFalse(publish.is_visible())

        preview.click()
        publish.click()
        result = self.page.locator('[data-package-result]')
        code = result.locator('code').inner_text()
        visitor = self.context.new_page()
        visitor.goto(result.locator('a').first.get_attribute('href'))
        visitor.get_by_label('Access code').fill(code)
        visitor.get_by_role('button', name='View document').click()
        visitor.locator('.package-directory > li > p a').first.click()
        visitor.get_by_text('First edition.').wait_for()
        self.assertEqual(visitor.get_by_role('link', name='Next document').count(), 0)

    def test_csv_comparison_and_saved_comment(self):
        self.go('/p/test/review-table')
        self.action_in_more('Compare with v1')
        self.page.get_by_label('Record ID column').select_option('id')
        self.page.get_by_role('button', name='Compare', exact=True).click()
        self.page.locator('select[name=filter]').select_option('changed')
        self.page.get_by_role('button', name='Apply filters').click()
        self.page.get_by_text('001', exact=False).first.wait_for()
        self.assertEqual(self.page.locator('.review-row').count(), 1)
        self.assertIn('Before', self.page.locator('.review-values').inner_text())
        self.assertIn('After', self.page.locator('.review-values').inner_text())
        self.page.get_by_label('Cell comment').fill('Check the updated value.')
        self.page.get_by_role('button', name='Save comment').click()
        self.page.get_by_role('heading', name='Saved cell comment').wait_for()
        self.go('/p/test/review-table')
        self.page.get_by_role('link', name='Open cell change').click()
        self.page.get_by_text('Check the updated value.', exact=True).wait_for()

    def test_image_zoom_and_matching_pdf_pages(self):
        source = self.fixture.tmp / 'media-review'
        source.mkdir()
        for v in [1, 2]:
            (source / 'chart.svg').write_text(f'<svg xmlns="http://www.w3.org/2000/svg" width="140" height="100"><rect width="{40*v}" height="100" fill="blue"/></svg>')
            (source / 'drawing.pdf').write_bytes(pdf_fixture(v))
            self.fixture.cli('publish', str(source), '--force-project', 'test', '--main', 'drawing.pdf', '--slug', 'review-media', '--json')
        self.go('/p/test/review-media?f=chart.svg')
        self.action_in_more('Compare with v1')
        self.page.wait_for_function('() => [...document.querySelectorAll(".review-media-pane img")].every(i => i.naturalWidth > 0)')
        width = self.page.locator('.review-media-pane img').first.bounding_box()['width']
        self.page.locator('[data-review-zoom]').evaluate("(el) => { el.value = '200'; el.dispatchEvent(new Event('input')); }")
        self.page.wait_for_function(f'() => document.querySelector(".review-media-pane img").clientWidth > {width * 1.9}')
        self.go('/p/test/review-media')
        self.action_in_more('Compare with v1')
        self.page.wait_for_function('() => !document.querySelector("[data-review-page]").disabled')
        self.page.locator('[data-review-page]').fill('2')
        self.page.locator('[data-review-page]').press('Tab')
        self.page.get_by_text('This version has no page with that number.').wait_for()
        self.page.wait_for_function('() => document.querySelectorAll("canvas[data-pdf-source]")[1].width > 300')

if __name__ == '__main__':
    unittest.main()
