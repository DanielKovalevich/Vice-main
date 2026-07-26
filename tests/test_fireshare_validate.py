"""Regression tests for the FireShare "Validate" settings action.

These exercise the real `_api_fireshare_validate` route together with the
real `FireShareClient` class (only the network layer is stubbed out), so
they would have failed for both prior bugs:

  * constructing `FireShareClient` with positional args when the class is
    keyword-only (fixed in 7443f53), and
  * calling the non-existent `client.close()` after `validate()`, since
    `FireShareClient` never owns a persistent session to close.
"""

import json
import unittest
from unittest import mock

from vice.config import Config, FireShareConfig

try:
    from vice.share import ShareServer
except ModuleNotFoundError:  # aiohttp not installed in this environment
    ShareServer = None


class _JsonRequest:
    """Minimal stand-in for an aiohttp request carrying a JSON body."""

    def __init__(self, body: dict) -> None:
        self._body = body
        self.can_read_body = True

    async def json(self) -> dict:
        return self._body


class _FakeResponse:
    def __init__(self, status: int, payload: dict) -> None:
        self.status = status
        self._text = json.dumps(payload)
        self.headers: dict = {}

    async def text(self) -> str:
        return self._text

    async def __aenter__(self) -> "_FakeResponse":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False


class _FakeSession:
    """Stand-in for aiohttp.ClientSession that never touches the network."""

    def __init__(self, response: _FakeResponse) -> None:
        self._response = response
        self.requested_urls: list[str] = []
        self.requested_headers: list[dict] = []

    def get(self, url: str, headers: dict | None = None) -> _FakeResponse:
        self.requested_urls.append(url)
        self.requested_headers.append(dict(headers or {}))
        return self._response

    async def __aenter__(self) -> "_FakeSession":
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False


@unittest.skipUnless(ShareServer is not None, "aiohttp is not installed")
class FireShareValidateRouteTests(unittest.IsolatedAsyncioTestCase):
    async def test_validate_succeeds_against_real_client_with_stubbed_network(self) -> None:
        """A 404 from the fake upload id is treated as a reachable/authorized server."""
        server = ShareServer(Config(fireshare=FireShareConfig(require_https=True)))
        request = _JsonRequest(
            {
                "base_url": "https://fireshare.example.com",
                # Not a real credential: fixed test-only placeholder value.
                "token": "test-placeholder-token",
            }
        )

        fake_session = _FakeSession(_FakeResponse(404, {}))
        with mock.patch(
            "vice.fireshare.aiohttp.ClientSession", return_value=fake_session
        ):
            response = await server._api_fireshare_validate(request)

        payload = json.loads(response.text)
        self.assertEqual(response.status, 200)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["base_url"], "https://fireshare.example.com")
        self.assertEqual(len(fake_session.requested_urls), 1)
        self.assertIn("/api/v1/uploads/", fake_session.requested_urls[0])

    async def test_validate_sends_the_real_token_as_a_bearer_header(self) -> None:
        """The request must actually authenticate with the caller's token — not
        a hardcoded placeholder — and the token must never end up anywhere
        else (payload, error text) besides this one outgoing header."""
        server = ShareServer(Config(fireshare=FireShareConfig(require_https=True)))
        placeholder_token = "test-placeholder-token-12345"
        request = _JsonRequest(
            {
                "base_url": "https://fireshare.example.com",
                "token": placeholder_token,
            }
        )

        fake_session = _FakeSession(_FakeResponse(404, {}))
        with mock.patch(
            "vice.fireshare.aiohttp.ClientSession", return_value=fake_session
        ):
            response = await server._api_fireshare_validate(request)

        self.assertEqual(len(fake_session.requested_headers), 1)
        auth_header = fake_session.requested_headers[0].get("Authorization")
        expected = f"Bearer {placeholder_token}"
        self.assertEqual(auth_header, expected)
        self.assertNotEqual(auth_header, "******")
        # The token must not leak into the JSON response body.
        self.assertNotIn(placeholder_token, response.text)


    async def test_validate_reports_remote_error_without_raising(self) -> None:
        """A 401 from the remote is surfaced as a clean ok=False payload."""
        server = ShareServer(Config(fireshare=FireShareConfig(require_https=True)))
        request = _JsonRequest(
            {
                "base_url": "https://fireshare.example.com",
                "token": "test-placeholder-token",
            }
        )

        error_payload = {"error": {"code": "unauthorized", "message": "Bad token"}}
        fake_session = _FakeSession(_FakeResponse(401, error_payload))
        with mock.patch(
            "vice.fireshare.aiohttp.ClientSession", return_value=fake_session
        ):
            response = await server._api_fireshare_validate(request)

        payload = json.loads(response.text)
        self.assertEqual(response.status, 400)
        self.assertFalse(payload["ok"])


if __name__ == "__main__":
    unittest.main()
