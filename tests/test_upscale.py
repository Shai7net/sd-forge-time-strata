"""venv\\Scripts\\python.exe tests\\test_upscale.py: Real-ESRGAN choices; with Deforum's realesrgan-ncnn-vulkan
installed, a real upscale of two small pictures (x2 by the video model, and a x4 model brought down to x2)."""
import os
import sys
import tempfile
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from strata import jobs, upscale  # noqa: E402


class Choices(unittest.TestCase):
    def test_choices_are_read(self):
        self.assertEqual(upscale.parse("realesr-animevideov3:2"), ("realesr-animevideov3", 2))
        self.assertEqual(upscale.parse("realesrgan-x4plus"), ("realesrgan-x4plus", 4))
        self.assertIsNone(upscale.parse(None))
        self.assertIsNone(upscale.parse(""))
        with self.assertRaises(jobs.JobError):
            upscale.parse("something-else:2")
        for choice in upscale.CHOICES:
            self.assertIsNotNone(upscale.parse(choice))


@unittest.skipUnless(upscale.find(), "realesrgan-ncnn-vulkan is not installed here")
class Real(unittest.TestCase):
    def test_pictures_come_out_at_the_asked_size(self):
        with tempfile.TemporaryDirectory() as folder:
            source = os.path.join(folder, "in")
            os.makedirs(source)
            for n in range(2):
                picture = np.full((40, 32, 3), 128, np.uint8)
                cv2.circle(picture, (16, 20), 9, (40, 90, 220), -1)
                cv2.imwrite(os.path.join(source, f"{n:06d}.png"), picture)
            for choice in ("realesr-animevideov3:2", "realesrgan-x4plus-anime:2"):
                target = os.path.join(folder, choice.replace(":", "_"))
                self.assertEqual(upscale.upscale_folder(source, target, choice), 2)
                for name in sorted(os.listdir(target)):
                    picture = cv2.imread(os.path.join(target, name))
                    self.assertEqual(picture.shape[:2], (80, 64), choice)
                    self.assertGreater(int(picture[40, 32, 2]), 150, "the red disc is still there, in the middle")


if __name__ == "__main__":
    unittest.main()
