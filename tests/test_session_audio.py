"""Session finalization and real channel-level checks for mono microphones."""

import math
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from vice.config import Config, RecordingConfig
from vice.recorder import GSRRecorder, _apply_volume_mix, _ffmpeg_audio_output_args


def inputs(mic_side="left", mic_only=False):
    mic = "0.08*sin(2*PI*880*t)"
    channels = f"{mic}|0" if mic_side == "left" else f"0|{mic}"
    args = ["-f", "lavfi", "-i", "color=size=96x54:rate=10:duration=1.2"]
    if not mic_only:
        args += ["-f", "lavfi", "-i",
                 "aevalsrc=0.06*sin(2*PI*440*t)|0.06*sin(2*PI*660*t):s=48000:d=1.2"]
    return args + ["-f", "lavfi", "-i", f"aevalsrc={channels}:s=48000:d=1.2"]


def video_hash(path):
    return subprocess.check_output(
        ["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v",
         "-c", "copy", "-f", "hash", "-"], timeout=15)


def channel_levels(path):
    raw = subprocess.check_output(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ss", "0.2", "-t", "0.6",
         "-map", "0:a:0", "-ac", "2", "-ar", "8000", "-f", "f32le", "-"], timeout=15)
    samples = struct.unpack(f"<{len(raw) // 4}f", raw)
    result = []
    for channel in (samples[0::2], samples[1::2]):
        result.append({freq: abs(sum(
            value * complex(math.cos(2 * math.pi * freq * i / 8000),
                            math.sin(2 * math.pi * freq * i / 8000))
            for i, value in enumerate(channel))) / len(channel)
            for freq in (440, 660, 880)})
    return result


class SessionAudioTests(unittest.IsolatedAsyncioTestCase):
    async def test_gsr_corrects_audio_before_watermark_and_notification(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.mp4"
            path.write_bytes(b"recording")
            recorder = GSRRecorder(Config(recording=RecordingConfig(microphone_mono=True)))
            recorder._session_active = True
            recorder._session_path = path
            recorder._session_proc = SimpleNamespace(stderr=None)
            recorder._session_program = "gpu-screen-recorder"
            recorder.cfg.recording.apply_watermark = True
            order = []

            async def correct(*_):
                order.append("audio")

            async def watermark(*_):
                order.append("watermark")

            recorder.on_clip_saved(lambda _: order.append("saved"))
            with mock.patch("vice.recorder._terminate_group"), \
                 mock.patch("vice.recorder._read_stream_text", return_value=""), \
                 mock.patch("vice.recorder._apply_volume_mix", side_effect=correct), \
                 mock.patch("vice.recorder._apply_watermark", side_effect=watermark):
                self.assertEqual(await recorder.stop_session(), path)
            self.assertEqual(order, ["audio", "watermark", "saved"])

    async def test_ffmpeg_session_does_not_apply_input_gain_twice(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.mp4"
            path.touch()
            recorder = GSRRecorder(Config(recording=RecordingConfig(microphone_volume=0.5)))
            recorder._session_active = True
            recorder._session_path = path
            recorder._session_proc = SimpleNamespace(stderr=None)
            recorder._session_program = "ffmpeg"
            with mock.patch("vice.recorder._terminate_group"), \
                 mock.patch("vice.recorder._read_stream_text", return_value=""), \
                 mock.patch("vice.recorder._apply_volume_mix") as correction:
                self.assertEqual(await recorder.stop_session(), path)
            correction.assert_not_awaited()

    async def test_long_sessions_have_time_to_process_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.mp4"
            path.write_bytes(b"original")
            rc = RecordingConfig(capture_microphone=True, microphone_mono=True)
            proc = SimpleNamespace(returncode=1)
            with mock.patch("vice.recorder._count_audio_streams", return_value=2), \
                 mock.patch("vice.recorder._get_duration", return_value=1800), \
                 mock.patch("vice.recorder.asyncio.create_subprocess_exec", return_value=proc), \
                 mock.patch("vice.recorder.communicate_with_timeout",
                            return_value=(b"", b"failed")) as communicate:
                await _apply_volume_mix(path, rc)
            communicate.assert_awaited_once_with(proc, 1800)
            self.assertEqual(path.read_bytes(), b"original")


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg not installed")
class SessionAudioSignalTests(unittest.IsolatedAsyncioTestCase):
    def assert_centred_mic_and_stereo_desktop(self, path):
        left, right = channel_levels(path)
        self.assertGreater(left[880], 0.015)
        self.assertAlmostEqual(left[880], right[880], delta=0.002)
        self.assertGreater(left[440], 10 * right[440])
        self.assertGreater(right[660], 10 * left[660])

    async def test_gsr_session_centres_either_mic_channel_and_copies_video(self):
        for ext, mic_side in (("mp4", "left"), ("mkv", "right")):
            with self.subTest(container=ext, mic_side=mic_side), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / f"session.{ext}"
                subprocess.run(
                    ["ffmpeg", "-v", "error", *inputs(mic_side),
                     "-map", "0:v", "-map", "1:a", "-map", "2:a",
                     "-c:v", "libx264", "-preset", "ultrafast", "-threads", "1",
                     "-c:a", "aac", str(path)], check=True, timeout=15)
                original_video = video_hash(path)
                recorder = GSRRecorder(Config(recording=RecordingConfig(
                    capture_microphone=True, microphone_mono=True)))
                recorder._session_active = True
                recorder._session_path = path
                recorder._session_proc = SimpleNamespace(stderr=None)
                recorder._session_program = "gpu-screen-recorder"
                with mock.patch("vice.recorder._terminate_group"), \
                     mock.patch("vice.recorder._read_stream_text", return_value=""):
                    self.assertEqual(await recorder.stop_session(), path)
                self.assert_centred_mic_and_stereo_desktop(path)
                self.assertEqual(video_hash(path), original_video)

    def test_ffmpeg_centres_mic_before_mixing_with_desktop(self):
        rc = RecordingConfig(capture_microphone=True, microphone_mono=True)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.mp4"
            subprocess.run(
                ["ffmpeg", "-v", "error", *inputs(), "-c:v", "libx264", "-threads", "1",
                 *_ffmpeg_audio_output_args(rc), str(path)], check=True, timeout=15)
            self.assert_centred_mic_and_stereo_desktop(path)

    def test_ffmpeg_mic_only_is_centred_at_the_requested_volume(self):
        rc = RecordingConfig(capture_audio=False, capture_microphone=True,
                             microphone_mono=True, microphone_volume=0.5)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.mp4"
            subprocess.run(
                ["ffmpeg", "-v", "error", *inputs(mic_only=True), "-c:v", "libx264", "-threads", "1",
                 *_ffmpeg_audio_output_args(rc), str(path)], check=True, timeout=15)
            left, right = channel_levels(path)
            self.assertAlmostEqual(left[880], right[880], delta=0.001)
            self.assertAlmostEqual(left[880], 0.01, delta=0.002)

    async def test_separate_tracks_remain_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.mkv"
            subprocess.run(
                ["ffmpeg", "-v", "error", *inputs(),
                 "-map", "0:v", "-map", "1:a", "-map", "2:a",
                 "-c:v", "libx264", "-threads", "1", "-c:a", "aac", str(path)],
                check=True, timeout=15)
            original = path.read_bytes()
            await _apply_volume_mix(path, RecordingConfig(
                capture_microphone=True, microphone_mono=True, audio_tracks=["default_output"]))
            self.assertEqual(path.read_bytes(), original)
