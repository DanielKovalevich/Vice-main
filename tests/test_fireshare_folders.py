from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from vice.config import Config, FireShareConfig

try:
    from aiohttp import ClientConnectionError

    from vice.fireshare import FireShareClient, FireShareError
    from vice.share import ShareServer
except ModuleNotFoundError:  # pragma: no cover - aiohttp missing
    FireShareClient = None
    ShareServer = None


class _FakeResponse:
    def __init__(self, status: int, payload: object) -> None:
        self.status = status
        self._text = json.dumps(payload)
        self.headers: dict[str, str] = {}

    async def text(self) -> str:
        return self._text

    async def __aenter__(self) -> "_FakeResponse":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False


class _FakeSession:
    def __init__(self, response: _FakeResponse) -> None:
        self.response = response
        self.urls: list[str] = []
        self.headers: list[dict] = []

    def get(self, url: str, headers: dict | None = None) -> _FakeResponse:
        self.urls.append(url)
        self.headers.append(dict(headers or {}))
        return self.response

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False


class _PublishRequest:
    def __init__(self, slug: str, body: dict) -> None:
        self.match_info = {"slug": slug}
        self._body = body

    async def json(self) -> dict:
        return self._body


@unittest.skipUnless(FireShareClient is not None, "aiohttp is not installed")
class FireShareFolderClientTests(unittest.IsolatedAsyncioTestCase):
    async def test_lists_folders_with_machine_token(self) -> None:
        token = "folder-test-token"
        session = _FakeSession(_FakeResponse(
            200,
            {"default_folder": "uploads", "folders": ["clips", "vice"]},
        ))
        client = FireShareClient(base_url="https://fireshare.example.com", token=token)

        with mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=session):
            result = await client.list_folders()

        self.assertEqual(result, {
            "default_folder": "uploads",
            "folders": ["clips", "vice"],
        })
        self.assertEqual(session.urls, ["https://fireshare.example.com/api/v1/folders"])
        self.assertEqual(session.headers[0]["Authorization"], f"Bearer {token}")

    async def test_remote_auth_error_is_preserved(self) -> None:
        session = _FakeSession(_FakeResponse(
            401,
            {"error": {"code": "unauthorized", "message": "Bad token"}},
        ))
        client = FireShareClient(
            base_url="https://fireshare.example.com",
            token="folder-test-token",
        )

        with mock.patch("vice.fireshare.aiohttp.ClientSession", return_value=session):
            with self.assertRaises(FireShareError) as raised:
                await client.list_folders()

        self.assertEqual(raised.exception.code, "unauthorized")
        self.assertEqual(raised.exception.status, 401)

    async def test_malformed_folder_responses_are_rejected(self) -> None:
        malformed = [
            {},
            {"default_folder": 7, "folders": []},
            {"default_folder": "uploads", "folders": "clips"},
            {"default_folder": "bad folder", "folders": []},
            {"default_folder": " uploads", "folders": []},
            {"default_folder": "uploads", "folders": ["bad/folder"]},
            {"default_folder": "uploads", "folders": ["clips "]},
            {"default_folder": "uploads", "folders": ["clips", "clips"]},
            {"default_folder": "uploads", "folders": ["clips", 7]},
        ]
        client = FireShareClient(
            base_url="https://fireshare.example.com",
            token="folder-test-token",
        )
        for payload in malformed:
            with self.subTest(payload=payload):
                session = _FakeSession(_FakeResponse(200, payload))
                with mock.patch(
                    "vice.fireshare.aiohttp.ClientSession",
                    return_value=session,
                ):
                    with self.assertRaises(FireShareError) as raised:
                        await client.list_folders()
                self.assertEqual(raised.exception.code, "invalid_response")

    def test_folder_validation_requires_an_exact_string(self) -> None:
        from vice.fireshare import validate_folder_name

        self.assertEqual(validate_folder_name("clips"), "clips")
        self.assertEqual(validate_folder_name("", allow_empty=True), "")
        for invalid in (" clips", "clips ", "bad folder", True, 7, None):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValueError):
                    validate_folder_name(invalid, allow_empty=True)


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class FireShareFolderRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.server = ShareServer(Config(fireshare=FireShareConfig(
            base_url="https://fireshare.example.com",
            require_https=True,
        )))

    async def test_proxy_returns_only_advisory_folder_data(self) -> None:
        token = "stored-folder-test-token"
        with mock.patch("vice.share.load_fireshare_token", return_value=token), \
             mock.patch(
                 "vice.share.FireShareClient.list_folders",
                 new=mock.AsyncMock(return_value={
                     "default_folder": "uploads",
                     "folders": ["clips", "vice"],
                 }),
             ) as list_folders:
            response = await self.server._api_fireshare_folders(mock.Mock())

        payload = json.loads(response.text)
        self.assertEqual(response.status, 200)
        self.assertEqual(payload, {
            "ok": True,
            "default_folder": "uploads",
            "folders": ["clips", "vice"],
        })
        self.assertEqual(response.headers["Cache-Control"], "no-store")
        self.assertNotIn(token, response.text)
        list_folders.assert_awaited_once_with()

    async def test_proxy_redacts_token_from_remote_auth_error(self) -> None:
        token = "stored-folder-test-token"
        error = FireShareError(
            "unauthorized",
            f"Remote rejected {token}",
            status=401,
        )
        with mock.patch("vice.share.load_fireshare_token", return_value=token), \
             mock.patch(
                 "vice.share.FireShareClient.list_folders",
                 new=mock.AsyncMock(side_effect=error),
             ):
            response = await self.server._api_fireshare_folders(mock.Mock())

        payload = json.loads(response.text)
        self.assertEqual(response.status, 401)
        self.assertEqual(payload["error_code"], "unauthorized")
        self.assertNotIn(token, response.text)
        self.assertIn("[redacted]", payload["error"])

    async def test_proxy_rejects_remote_data_that_reflects_the_token(self) -> None:
        token = "stored-folder-test-token"
        with mock.patch("vice.share.load_fireshare_token", return_value=token), \
             mock.patch(
                 "vice.share.FireShareClient.list_folders",
                 new=mock.AsyncMock(return_value={
                     "default_folder": "uploads",
                     "folders": [token],
                 }),
             ):
            response = await self.server._api_fireshare_folders(mock.Mock())

        payload = json.loads(response.text)
        self.assertEqual(response.status, 502)
        self.assertEqual(payload["error_code"], "invalid_response")
        self.assertNotIn(token, response.text)

    async def test_proxy_returns_structured_unavailable_error(self) -> None:
        with mock.patch(
            "vice.share.load_fireshare_token",
            return_value="stored-folder-test-token",
        ), mock.patch(
            "vice.share.FireShareClient.list_folders",
            new=mock.AsyncMock(side_effect=ClientConnectionError("offline")),
        ):
            response = await self.server._api_fireshare_folders(mock.Mock())

        payload = json.loads(response.text)
        self.assertEqual(response.status, 502)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error_code"], "fireshare_unavailable")
        self.assertTrue(payload["error"])

    async def test_proxy_returns_json_for_unexpected_failures(self) -> None:
        token = "stored-folder-test-token"
        with mock.patch("vice.share.load_fireshare_token", return_value=token), \
             mock.patch(
                 "vice.share.FireShareClient.list_folders",
                 new=mock.AsyncMock(side_effect=RuntimeError(token)),
             ), mock.patch("vice.share.log.exception"):
            response = await self.server._api_fireshare_folders(mock.Mock())

        payload = json.loads(response.text)
        self.assertEqual(response.status, 502)
        self.assertEqual(payload["error_code"], "fireshare_error")
        self.assertNotIn(token, response.text)

    async def test_proxy_requires_stored_configuration(self) -> None:
        with mock.patch("vice.share.load_fireshare_token", return_value=""):
            response = await self.server._api_fireshare_folders(mock.Mock())

        payload = json.loads(response.text)
        self.assertEqual(response.status, 400)
        self.assertEqual(payload["error_code"], "not_configured")

    async def test_publish_rejects_falsy_non_string_folder_values(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            clip_path = Path(tmp) / "clip.mp4"
            clip_path.write_bytes(b"clip")
            self.server._clips["clip"] = clip_path
            manager = mock.Mock()
            manager.is_active_slug.return_value = False
            manager.publish = mock.AsyncMock()
            self.server._fireshare = manager

            for invalid in (None, False, 0, [], {}):
                with self.subTest(invalid=invalid), mock.patch(
                    "vice.share.load_fireshare_token",
                    return_value="stored-folder-test-token",
                ):
                    response = await self.server._api_clip_fireshare_publish(
                        _PublishRequest("clip", {"folder": invalid})
                    )
                payload = json.loads(response.text)
                self.assertEqual(response.status, 400)
                self.assertEqual(payload["error_code"], "invalid_folder")
            manager.publish.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
