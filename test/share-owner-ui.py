"""Owner sharing guidance regressions; isolated server, mocked network status only."""
from pathlib import Path
import json
from datetime import datetime, timedelta, timezone
import runpy
import sys
import unittest

_base = runpy.run_path(str(Path(__file__).with_name('ui-review.py')), run_name='share_owner_base')['ReviewUI']


class ShareOwnerUI(_base):
    def status_fixture(self, **changes):
        value = {'enabled': True, 'phase': 'configured', 'publicUrl': 'https://example.ts.net:8443',
                 'pdfReady': True, 'externalVerified': False, 'checks': {'installed': True, 'loggedIn': True,
                 'https': True, 'configured': True, 'funnel': True, 'localReady': True}, 'errorCode': '',
                 'authUrl': '', 'activeShares': 0, **changes}
        self.page.route('**/api/sharing/status', lambda route: route.fulfill(status=200,
            content_type='application/json', body=json.dumps(value)))
        return value

    def test_persisted_setup_error_explains_port_conflict_after_reload(self):
        self.status_fixture(enabled=False, phase='error', errorCode='SHARE_PORT_BUSY')
        self.go('/settings')
        status = self.page.locator('[data-sharing-status]')
        self.assertIn('dedicated sharing ports are in use', status.inner_text())
        self.page.reload()
        status.filter(has_text='dedicated sharing ports are in use').wait_for()
        self.assertNotEqual(status.inner_text(), 'Internet sharing is off.')

    def test_article_warns_when_pdf_is_not_ready(self):
        self.status_fixture(pdfReady=False)
        self.publish('owner-pdf-readiness', '# Owner article')
        self.go('/p/test/owner-pdf-readiness')
        self.page.locator('[data-share-open]').click()
        warning = self.page.locator('[data-sharing-article-pdf]')
        warning.wait_for()
        self.assertIn('PDF downloads are not ready', warning.inner_text())
        self.assertIn('Chrome or Edge', warning.inner_text())
        self.assertTrue(warning.get_by_role('link', name='Set up PDF downloads').is_visible())

    def test_stale_secondary_document_link_keeps_file_context(self):
        self.status_fixture()
        folder = self.tmp / 'owner-secondary'; folder.mkdir()
        (folder / 'main.md').write_text('# Main document')
        (folder / 'secondary.md').write_text('# Secondary document')
        self.cli('publish', str(folder), '--main', 'main.md', '--force-project', 'test', '--slug', 'owner-secondary', '--json')
        self.page.route('**/api/shares', lambda route: route.fulfill(status=409, content_type='application/json',
            body=json.dumps({'code': 'DOCUMENT_UPDATED', 'error': 'Document updated.'})))
        self.go('/p/test/owner-secondary?f=secondary.md')
        self.page.locator('[data-share-open]').click()
        self.page.locator('[data-share-submit]').click()
        link = self.page.locator('[data-share-owner-status]').get_by_role('link', name='Open latest version')
        link.wait_for()
        self.assertEqual(link.get_attribute('href'), '/p/test/owner-secondary?f=secondary.md')

    def test_unsupported_client_and_pending_cleanup_have_actions(self):
        self.status_fixture(enabled=False, phase='error', errorCode='TAILSCALE_UNSUPPORTED')
        self.go('/settings')
        self.page.locator('[data-sharing-status]').filter(has_text='supported open-source client').wait_for()
        self.assertTrue(self.page.locator('[data-sharing-client-help] a').is_visible())
        self.page.unroute('**/api/sharing/status')
        self.status_fixture(enabled=False, phase='error', errorCode='FUNNEL_CLEANUP_FAILED', cleanupPending=True)
        self.go('/settings')
        self.page.locator('[data-sharing-status]').filter(has_text='public entry could not be removed').wait_for()
        self.assertTrue(self.page.get_by_role('button', name='Finish disabling sharing').is_visible())

    def test_stale_article_preserves_newer_shared_files_when_editing_permissions(self):
        self.status_fixture()
        self.publish('owner-stale-files', '# Old article bootstrap')
        expiry = (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()
        current = {'id': 'a' * 32, 'project': 'test', 'slug': 'owner-stale-files',
            'main': 'owner-stale-files.md', 'files': ['owner-stale-files.md', 'newly-shared.csv'],
            'title': 'Newer shared files', 'version': 2, 'mode': 'latest', 'allowPdf': True,
            'allowComments': True, 'expiresAt': expiry, 'status': 'active', 'revoked': False,
            'commentCount': 0, 'fileMetadata': [
                {'path': 'owner-stale-files.md', 'kind': 'md', 'size': 30},
                {'path': 'newly-shared.csv', 'kind': 'table', 'size': 20}]}
        saved = []
        self.page.route('**/api/shares?*', lambda route: route.fulfill(status=200,
            content_type='application/json', body=json.dumps({'shares': [current], 'comments': [],
            'publicUrl': 'https://example.ts.net:8443'})))
        def save(route):
            body = route.request.post_data_json; saved.append(body); current.update(body)
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'share': current}))
        self.page.route('**/api/shares/' + current['id'], save)
        self.go('/p/test/owner-stale-files')
        self.page.locator('[data-share-open]').click()
        self.page.locator('[data-share-tab="manage"]').click()
        self.page.locator('[data-share-action="edit"]').click()
        edit = self.page.locator('.share-owner-edit')
        self.assertEqual(edit.locator('[name="files"][value="newly-shared.csv"]').count(), 1)
        self.assertTrue(edit.locator('[name="files"][value="newly-shared.csv"]').is_checked())
        edit.locator('[name="allowComments"]').uncheck()
        edit.get_by_role('button', name='Save', exact=True).click()
        edit.wait_for(state='detached')
        self.assertEqual(saved[-1]['files'], ['owner-stale-files.md', 'newly-shared.csv'])

    def test_bulk_file_selection_counts_files_and_keeps_the_main_document(self):
        self.status_fixture()
        folder = self.tmp / 'owner-file-selection'; folder.mkdir()
        (folder / 'main.md').write_text('# Main')
        (folder / 'notes.md').write_text('# Notes')
        (folder / 'rows.csv').write_text('name,value\nA,1\n')
        self.cli('publish', str(folder), '--main', 'main.md', '--force-project', 'test', '--slug', 'owner-file-selection', '--json')
        self.go('/p/test/owner-file-selection')
        self.page.locator('[data-share-open]').click()
        form = self.page.locator('#share-create-form')
        self.assertEqual(form.locator('[name="files"]:checked').count(), 1)
        form.get_by_role('button', name='Select all files', exact=True).click()
        self.assertEqual(form.locator('[name="files"]:checked').count(), 3)
        self.assertIn('3 files selected', form.locator('[data-share-selected-count]').inner_text())
        form.get_by_role('button', name='Main document only', exact=True).click()
        checked = form.locator('[name="files"]:checked')
        self.assertEqual(checked.count(), 1)
        self.assertEqual(checked.get_attribute('value'), 'main.md')
        self.assertTrue(checked.is_disabled())
        self.assertIn('1 file selected', form.locator('[data-share-selected-count]').inner_text())

    def test_archive_guard_explains_active_shares_and_opens_stop_management(self):
        self.status_fixture()
        self.publish('owner-archive-warning', '# Shared document')
        current = {'id': 'a' * 32, 'project': 'test', 'slug': 'owner-archive-warning',
            'main': 'owner-archive-warning.md', 'files': ['owner-archive-warning.md'],
            'title': 'Active share', 'version': 1, 'mode': 'latest', 'allowPdf': True,
            'allowComments': True, 'expiresAt': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            'status': 'active', 'revoked': False, 'commentCount': 0,
            'fileMetadata': [{'path': 'owner-archive-warning.md', 'kind': 'md', 'size': 30}]}
        self.page.route('**/api/shares?*', lambda route: route.fulfill(status=200,
            content_type='application/json', body=json.dumps({'shares': [current], 'comments': [],
            'publicUrl': 'https://example.ts.net:8443'})))
        self.go('/p/test/owner-archive-warning')
        self.assertEqual(self.page.evaluate('typeof window.mydashBeforeArchive'), 'function')
        self.page.evaluate('window.__archiveDecision=null; void window.mydashBeforeArchive().then(value=>window.__archiveDecision=value)')
        confirm = self.page.locator('[data-sharing-confirm][open]'); confirm.wait_for()
        self.assertIn('Archiving does not stop', confirm.inner_text())
        confirm.get_by_role('button', name='Cancel', exact=True).click()
        self.page.wait_for_function('window.__archiveDecision===false')
        self.page.evaluate('window.__archiveDecision=null; void window.mydashBeforeArchive().then(value=>window.__archiveDecision=value)')
        confirm.wait_for(); confirm.get_by_role('button', name='Manage and stop shares', exact=True).click()
        self.page.wait_for_function('window.__archiveDecision===false')
        self.page.locator('#share-owner-dialog[open] [data-share-manage]').wait_for(state='visible')
        self.assertTrue(self.page.locator('[data-share-action="revoke"]').is_visible())

    def test_archive_double_click_runs_one_confirmation_and_restores_button(self):
        self.status_fixture()
        self.publish('owner-archive-double', '# Shared document')
        current = {'id': 'a' * 32, 'project': 'test', 'slug': 'owner-archive-double',
            'main': 'owner-archive-double.md', 'files': ['owner-archive-double.md'],
            'title': 'Active share', 'version': 1, 'mode': 'latest', 'allowPdf': True,
            'allowComments': True, 'expiresAt': (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(),
            'status': 'active', 'revoked': False, 'commentCount': 0,
            'fileMetadata': [{'path': 'owner-archive-double.md', 'kind': 'md', 'size': 30}]}
        self.page.route('**/api/shares?*', lambda route: route.fulfill(status=200,
            content_type='application/json', body=json.dumps({'shares': [current], 'comments': [],
            'publicUrl': 'https://example.ts.net:8443'})))
        posted = []
        def archive_request(route):
            posted.append(route.request.post_data_json)
            route.continue_()
        self.page.route('**/api/archive', archive_request)
        self.page.set_viewport_size({'width': 1440, 'height': 960})
        self.go('/p/test/owner-archive-double')
        self.page.evaluate('''() => {
            const original = window.mydashBeforeArchive;
            window.__archiveCalls = 0; window.__archiveReturns = 0;
            window.mydashBeforeArchive = async () => {
                window.__archiveCalls++;
                const answer = await original();
                window.__archiveReturns++;
                return answer;
            };
            window.__doubleArchive = () => {
                const button = document.querySelector('.arch-btn');
                button.click();
                button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            };
            window.__doubleArchive();
        }''')
        button = self.page.locator('.arch-btn')
        confirm = self.page.locator('[data-sharing-confirm][open]'); confirm.wait_for()
        self.assertEqual(self.page.evaluate('window.__archiveCalls'), 1)
        self.assertTrue(button.is_disabled())
        confirm.get_by_role('button', name='Cancel', exact=True).click()
        self.page.wait_for_function('!document.querySelector(".arch-btn").disabled')
        self.assertEqual(self.page.evaluate('window.__archiveReturns'), 1)
        self.assertIsNone(button.get_attribute('data-busy'))
        self.assertEqual(posted, [])

        self.page.evaluate('window.__doubleArchive()')
        confirm.wait_for()
        self.assertEqual(self.page.evaluate('window.__archiveCalls'), 2)
        confirm.get_by_role('button', name='Archive anyway', exact=True).click()
        self.page.wait_for_function('''() => {
            const button = document.querySelector('.arch-btn');
            return button.dataset.archived === '1' && !button.disabled;
        }''')
        self.assertEqual(self.page.evaluate('window.__archiveReturns'), 2)
        self.assertIsNone(button.get_attribute('data-busy'))
        self.assertEqual(posted, [{'id': 'test/owner-archive-double', 'archived': True}])
        button.click()
        self.page.wait_for_function('''() => {
            const button = document.querySelector('.arch-btn');
            return button.dataset.archived === '0' && !button.disabled;
        }''')
        self.assertEqual(len(posted), 2)
        self.assertEqual(posted[-1]['archived'], False)
        self.assertEqual(self.page.evaluate('window.__archiveCalls'), 2)


if __name__ == '__main__':
    names = [name for name in ShareOwnerUI.__dict__ if name.startswith('test_')]
    suite = unittest.TestSuite(ShareOwnerUI(name) for name in names)
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    sys.exit(0 if result.wasSuccessful() else 1)
