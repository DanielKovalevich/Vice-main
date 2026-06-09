import asyncio
import unittest
from unittest import mock

from vice.hotkey import HotkeyListener


class _FakeDevice:
    """Stands in for evdev.InputDevice."""

    def __init__(self, path: str, *, dies: bool = False) -> None:
        self.path = path
        self.name = f"fake-{path}"
        self.closed = False
        self._dies = dies

    async def async_read_loop(self):
        if self._dies:
            raise OSError(19, "No such device")
        while True:
            await asyncio.sleep(3600)
            yield  # pragma: no cover — never reached

    def close(self) -> None:
        self.closed = True


class HotkeyHotplugTests(unittest.IsolatedAsyncioTestCase):
    async def test_listener_reattaches_after_keyboard_replug(self) -> None:
        """Regression test for #65: a disconnected keyboard must not leave
        the listener stuck until a daemon restart."""
        dying = _FakeDevice("/dev/input/event2", dies=True)
        replug = _FakeDevice("/dev/input/event5")
        # Scan results over time: device present, gone, replugged.
        scans = [[dying], [], [replug]]

        def _fake_find(skip_paths=None):
            batch = scans.pop(0) if scans else []
            skip = skip_paths or set()
            return [d for d in batch if d.path not in skip]

        availability: list[bool] = []
        listener = HotkeyListener()
        listener.on_availability_change = availability.append

        with mock.patch("vice.hotkey._find_keyboards", side_effect=_fake_find):
            with mock.patch("vice.hotkey.RESCAN_INTERVAL", 0.03):
                await listener.start()
                self.assertTrue(listener.available)

                # Wait until the supervisor has reaped the dead device and
                # attached the replugged one.
                for _ in range(100):
                    await asyncio.sleep(0.02)
                    if replug.path in listener._listeners and listener.available:
                        break
                self.assertIn(replug.path, listener._listeners)
                self.assertNotIn(dying.path, listener._listeners)
                self.assertTrue(listener.available)
                await listener.stop()

        # Availability flapped: down when the keyboard died, up on replug.
        self.assertIn(False, availability)
        self.assertEqual(availability[-1], True)
        self.assertTrue(dying.closed)

    async def test_start_without_keyboards_keeps_watching(self) -> None:
        keyboard = _FakeDevice("/dev/input/event3")
        scans = [[], [keyboard]]

        def _fake_find(skip_paths=None):
            batch = scans.pop(0) if scans else []
            skip = skip_paths or set()
            return [d for d in batch if d.path not in skip]

        listener = HotkeyListener()
        with mock.patch("vice.hotkey._find_keyboards", side_effect=_fake_find):
            with mock.patch("vice.hotkey.RESCAN_INTERVAL", 0.03):
                await listener.start()
                self.assertFalse(listener.available)

                for _ in range(100):
                    await asyncio.sleep(0.02)
                    if listener.available:
                        break
                self.assertTrue(listener.available)
                await listener.stop()

    async def test_stop_cancels_supervisor_and_listeners(self) -> None:
        keyboard = _FakeDevice("/dev/input/event4")

        def _fake_find(skip_paths=None):
            skip = skip_paths or set()
            return [keyboard] if keyboard.path not in skip else []

        listener = HotkeyListener()
        with mock.patch("vice.hotkey._find_keyboards", side_effect=_fake_find):
            await listener.start()
            supervisor = listener._supervisor
            await listener.stop()

        self.assertEqual(listener._listeners, {})
        self.assertIsNone(listener._supervisor)
        self.assertTrue(supervisor.cancelled() or supervisor.done())
        self.assertTrue(keyboard.closed)


if __name__ == "__main__":
    unittest.main()
