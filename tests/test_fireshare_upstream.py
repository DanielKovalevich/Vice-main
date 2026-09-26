"""Exercise stock Fireshare's contract over real multipart HTTP, without a job API."""
import asyncio
import hashlib
import tempfile
import unittest
from pathlib import Path

import xxhash
from aiohttp import web
from aiohttp.test_utils import TestServer

from vice.fireshare import FireShareClient, FireShareError, resolve_destination


class OfficialUploadTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.clip = Path(self.temp.name) / 'clip.mp4'
        self.clip.write_bytes(b'clip content')
        self.options = {
            'default_folder': 'uploads',
            'folders': {'video': ['uploads', 'Space Game', 'Other Game']},
            'games': [{'id': 3, 'name': 'Space Game'}, {'id': 4, 'name': 'Other Game'}],
            'folder_rules': {'video': [{'folder': 'Space Game', 'game_id': 3},
                                       {'folder': 'Other Game', 'game_id': 4}]},
        }
        self.fields = {}
        self.body = b''
        self.requests = []
        self.mode = 'accepted'
        app = web.Application(client_max_size=32 * 1024 * 1024)
        app.router.add_get('/api/upload/token/options', self.get_options)
        app.router.add_get('/api/upload/token', self.check)
        app.router.add_post('/api/upload/token', self.upload)
        self.server = TestServer(app)
        await self.server.start_server()
        self.base_url = str(self.server.make_url('')).rstrip('/')
        self.client = FireShareClient(base_url=self.base_url, token='fixture-secret')

    async def asyncTearDown(self):
        await self.server.close()
        self.temp.cleanup()

    def record(self, request):
        self.requests.append((request.method, request.path))
        self.assertEqual(request.headers.get('Authorization'), 'Bearer fixture-secret')
        self.assertNotIn('Idempotency-Key', request.headers)

    async def get_options(self, request):
        self.record(request)
        return web.json_response(self.options)

    async def check(self, request):
        self.record(request)
        return web.json_response({'ok': True, 'username': 'uploader'})

    async def upload(self, request):
        self.record(request)
        reader = await request.multipart()
        async for part in reader:
            if part.name == 'file':
                self.body = bytes(await part.read())
            else:
                self.fields[part.name] = await part.text()
        if self.mode == 'duplicate':
            return web.json_response({'error': 'duplicate', 'video_id': xxhash.xxh3_128_hexdigest(self.body[:16*1024*1024]),
                                      'title': 'Already there'}, status=409)
        if self.mode == 'invalid_token':
            return web.Response(text='Invalid upload token.', status=401)
        if self.mode == 'wrong_id':
            return web.json_response({'error': 'duplicate', 'video_id': '0'*32}, status=409)
        if self.mode == 'redirect':
            return web.Response(status=302, headers={'Location': '/api/upload/token'})
        return web.json_response({'status': 'accepted', 'media_type': 'video', 'filename': 'clip.mp4',
                                  'folder': 'elsewhere' if self.mode == 'wrong_folder' else self.fields['folder']}, status=201)

    async def send(self, **overrides):
        args = dict(clip_path=self.clip, idempotency_key='local-attempt', title='Round win',
                    folder='Space Game', private=None, game_id=3, tag_ids=[], on_progress=lambda *_: None)
        args.update(overrides)
        return await self.client.upload(**args)

    async def test_link_returned_on_acceptance_with_exact_destination_and_no_poll(self):
        completed = []
        status, result, delay, source_hash = await self.send(on_upload_complete=lambda: completed.append(True))
        expected_id = xxhash.xxh3_128_hexdigest(self.body)
        self.assertEqual((status, result.status, delay), (201, 'uploaded', 0))
        self.assertEqual(result.public_url, f'{self.base_url}/w/{expected_id}')
        self.assertEqual((result.folder, result.game_id), ('Space Game', 3))
        self.assertIsNone(result.job_id)
        self.assertIsNone(result.private)
        self.assertEqual(self.fields, {'title': 'Round win', 'folder': 'Space Game', 'game_id': '3'})
        self.assertEqual(source_hash, hashlib.sha256(self.body).hexdigest())
        self.assertEqual(completed, [True])
        self.assertEqual(self.requests, [('GET', '/api/upload/token/options'), ('POST', '/api/upload/token')])

    async def test_id_matches_upstream_at_and_beyond_16_mib(self):
        prefix = bytes(range(256)) * (16 * 1024 * 1024 // 256)
        for content in (prefix, prefix + b'different tail'):
            with self.subTest(size=len(content)):
                self.clip.write_bytes(content)
                _, result, _, digest = await self.send()
                self.assertEqual(result.video_id, xxhash.xxh3_128_hexdigest(prefix))
                self.assertEqual(digest, hashlib.sha256(content).hexdigest())
                self.assertEqual(self.body, content)

    async def test_folder_rule_resolves_game_and_default_folder_is_explicit(self):
        _, result, _, _ = await self.send(game_id=None)
        self.assertEqual(result.game_id, 3)
        self.assertEqual(self.fields['game_id'], '3')
        _, result, _, _ = await self.send(folder='', game_id=4)
        self.assertEqual(result.folder, 'uploads')
        self.assertEqual(self.fields['folder'], 'uploads')

    async def test_conflicting_or_deleted_game_is_rejected_before_transferring(self):
        for game, code in [(4, 'destination_conflict'), (999, 'unknown_game')]:
            with self.subTest(game=game), self.assertRaises(FireShareError) as raised:
                await self.send(game_id=game)
            self.assertEqual(raised.exception.code, code)
        self.assertFalse(any(method == 'POST' for method, _ in self.requests))

    async def test_new_folder_preserves_spaces_and_game(self):
        _, result, _, _ = await self.send(folder='New game clips')
        self.assertEqual((result.folder, result.game_id), ('New game clips', 3))

    async def test_duplicate_returns_link_without_claiming_requested_destination(self):
        self.mode = 'duplicate'
        status, result, _, _ = await self.send()
        self.assertEqual(status, 409)
        self.assertTrue(result.deduplicated)
        self.assertEqual(result.status, 'uploaded')
        self.assertTrue(result.public_url.startswith(self.base_url + '/w/'))
        self.assertIsNone(result.folder)
        self.assertIsNone(result.game_id)

    async def test_wrong_folder_wrong_duplicate_id_and_redirect_are_not_success(self):
        for mode, code in [('wrong_folder', 'destination_mismatch'), ('wrong_id', 'invalid_response'), ('redirect', 'invalid_response')]:
            self.mode = mode
            with self.subTest(mode=mode), self.assertRaises(FireShareError) as raised:
                await self.send()
            self.assertEqual(raised.exception.code, code)

    async def test_plain_text_auth_error_remains_structured(self):
        self.mode = 'invalid_token'
        with self.assertRaises(FireShareError) as raised:
            await self.send()
        self.assertEqual(raised.exception.status, 401)
        self.assertEqual(raised.exception.source_sha256, hashlib.sha256(self.body).hexdigest())
        self.assertNotIn('fixture-secret', str(raised.exception))

    async def test_validation_checks_official_endpoint(self):
        self.assertTrue((await self.client.validate())['ok'])
        self.assertEqual(self.requests, [('GET', '/api/upload/token')])

    async def test_invalid_directory_choices_are_filtered(self):
        self.options['folders']['video'] += ['.hidden', 'bad/name', ' Space ']
        options = await self.client.list_folders()
        self.assertEqual(options['folders'], ['Other Game', 'Space Game', 'uploads'])
        self.assertEqual(options['games'], self.options['games'])


class DestinationRulesTests(unittest.TestCase):
    def test_ambiguous_folder_rules_are_blocked(self):
        with self.assertRaises(FireShareError):
            resolve_destination({'default_folder': 'clips', 'games': [{'id': 1}, {'id': 2}],
                                 'folder_rules': [{'folder': 'clips', 'game_id': 1}, {'folder': 'clips', 'game_id': 2}]}, '', None)


class PublicationRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        from vice.library import ClipLibrary, ObservedFile
        from vice.fireshare import FireSharePublishManager
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / 'library.sqlite3'
        self.library = ClipLibrary(self.db_path)
        self.addCleanup(self.library.close)
        self.clip_id = self.library.catalog_clip(ObservedFile(slug='clip', size=10, mtime_ns=1))
        self.events = []
        async def broadcast(event):
            self.events.append(event)
        self.manager = FireSharePublishManager(library=self.library, broadcast=broadcast,
            resolve_clip=lambda _: None, resolve_clip_by_uuid=lambda _: None)

    def save(self, **changes):
        attempt = dict(attempt_id='attempt', clip_uuid=self.clip_id, idempotency_key='attempt',
                       source_size=10, source_mtime_ns=1, state='uploading', tag_ids_json='[]',
                       created_at='2026-09-25', updated_at='2026-09-25')
        attempt.update(changes)
        self.library.save_fireshare_attempt(attempt)
        self.library.set_fireshare_current(self.clip_id, current_attempt_id='attempt')

    async def test_accepted_link_is_saved_as_terminal_without_processing_poll(self):
        from vice.fireshare import FireShareJobEnvelope
        self.save()
        envelope = FireShareJobEnvelope(None, 'a'*32, 'https://clips.example/w/'+'a'*32,
            '/w/'+'a'*32, 'uploaded', None, 'clip', False, None, None, None, 'Space Game', 3)
        await self.manager._merge_remote_envelope('attempt', 'clip', self.clip_id,
            status_code=201, envelope=envelope, retry_after=0, source_sha256='digest')
        current = self.library.get_fireshare_current(self.clip_id)
        self.assertEqual(current['current']['state'], 'uploaded')
        self.assertEqual(current['last_ready']['public_url'], envelope.public_url)
        self.assertEqual(current['current']['game_id'], 3)
        self.assertFalse(self.library.list_nonterminal_fireshare_attempts())
        self.assertEqual(self.events[-1]['type'], 'fireshare_publish_uploaded')
        self.library.close()
        from vice.library import ClipLibrary
        reopened = ClipLibrary(self.db_path)
        try:
            self.assertEqual(reopened.get_fireshare_current(self.clip_id)['current']['public_url'], envelope.public_url)
        finally:
            reopened.close()

    async def test_legacy_processing_link_survives_without_calling_retired_api(self):
        self.save(state='processing', job_id='old-job', remote_status='processing',
                  public_url='https://clips.example/w/old')
        await self.manager.resume_nonterminal(base_url='https://unreachable.invalid', token='not-used')
        current = self.library.get_fireshare_current(self.clip_id)
        self.assertEqual(current['current']['state'], 'uploaded')
        self.assertEqual(current['last_ready']['public_url'], 'https://clips.example/w/old')
        self.assertFalse(self.manager._tasks)

    async def test_unconfirmed_upload_requires_explicit_retry_after_restart(self):
        self.save()
        await self.manager.resume_nonterminal(base_url='https://unreachable.invalid', token='not-used')
        current = self.library.get_fireshare_current(self.clip_id)['current']
        self.assertEqual(current['state'], 'failed')
        self.assertEqual(current['error_code'], 'resume_required')
        self.assertIsNone(current['public_url'])
        self.assertFalse(self.manager._tasks)
