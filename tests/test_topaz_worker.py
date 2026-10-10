import importlib.util
import pathlib
import tempfile
import unittest


WORKER = pathlib.Path(__file__).parents[1] / "mini-services" / "hub-service" / "topaz-worker.py"
SPEC = importlib.util.spec_from_file_location("topaz_worker", WORKER)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class Button:
    def __init__(self, close_on):
        self.close_on = close_on
        self.calls = []

    def invoke(self):
        self.calls.append("invoke")

    def click_input(self):
        self.calls.append("click_input")


def immediate_wait(check, timeout, description):
    if not check():
        raise RuntimeError(description)


class TelegramSendTests(unittest.TestCase):
    def test_falls_back_when_physical_click_is_silently_ignored(self):
        state = {"pending": True}
        button = Button("invoke")
        original_invoke = button.invoke

        def invoke():
            original_invoke()
            state["pending"] = False

        button.invoke = invoke
        MODULE.activate_telegram_send(button, lambda: state["pending"], immediate_wait)
        self.assertEqual(button.calls, ["click_input", "invoke"])

    def test_never_invokes_after_physical_click_starts_send(self):
        state = {"pending": True}
        button = Button("click_input")
        original_click = button.click_input

        def click():
            original_click()
            state["pending"] = False

        button.click_input = click
        MODULE.activate_telegram_send(button, lambda: state["pending"], immediate_wait)
        self.assertEqual(button.calls, ["click_input"])

    def test_reports_failure_if_telegram_ignores_both_actions(self):
        button = Button(None)
        with self.assertRaisesRegex(RuntimeError, "не начал отправку"):
            MODULE.activate_telegram_send(button, lambda: True, immediate_wait)


class LargeImageTests(unittest.TestCase):
    def test_dimension_reader_temporarily_disables_pillow_pixel_guard(self):
        from PIL import Image
        with tempfile.TemporaryDirectory() as directory:
            image_path = pathlib.Path(directory) / "large-source.png"
            Image.new("RGB", (32, 24), "white").save(image_path)
            original = Image.MAX_IMAGE_PIXELS
            Image.MAX_IMAGE_PIXELS = 1
            try:
                self.assertEqual(MODULE.verified_image_dimensions(image_path), (32, 24))
                self.assertEqual(Image.MAX_IMAGE_PIXELS, 1)
            finally:
                Image.MAX_IMAGE_PIXELS = original


class ComboValueTests(unittest.TestCase):
    class Combo:
        def __init__(self, window="", accessible="", children=()):
            self._window = window
            self._accessible = accessible
            self._children = [ComboValueTests.Combo(window=value) for value in children]
            self.actions = []

        def window_text(self):
            return self._window

        @property
        def element_info(self):
            outer = self
            class Element:
                def GetCurrentPropertyValue(self, property_id):
                    return outer._accessible
            class Info:
                element = Element()
            return Info()

        def descendants(self, control_type=None):
            return self._children

        def click_input(self):
            self.actions.append("open")

        def type_keys(self, keys):
            self.actions.append(keys)
            if keys == "{HOME}{ENTER}":
                self._window = "px"

        def rectangle(self):
            class Rect:
                left, right, top, bottom = 0, 100, 0, 30
            return Rect()

    def test_topaz_dimension_unit_accepts_qt_text_variants(self):
        self.assertTrue(MODULE.combo_has_value(self.Combo(window="px"), "px"))
        self.assertTrue(MODULE.combo_has_value(self.Combo(accessible="W: px"), "px"))
        self.assertTrue(MODULE.combo_has_value(self.Combo(children=["px"]), "px"))
        self.assertFalse(MODULE.combo_has_value(self.Combo(window="in"), "px"))
        self.assertTrue(MODULE.combo_has_value(self.Combo(window="Format: JPEG"), "JPEG"))
        self.assertTrue(MODULE.combo_has_value(self.Combo(accessible="JPEG JPEG"), "JPEG"))
        self.assertTrue(MODULE.combo_has_value(self.Combo(window="Color space: Adobe RGB (1998)"), "Adobe RGB (1998)"))

    def test_dimension_combo_changes_inches_and_centimeters_back_to_pixels(self):
        class Host:
            def __init__(self, selected):
                self.element = ComboValueTests.Combo(window=selected)
            def near(self, label, kind):
                return self.element
            def elements(self, kind):
                return []
        original_sleep = MODULE.time.sleep
        MODULE.time.sleep = lambda seconds: None
        try:
            for selected in ("in", "cm"):
                host = Host(selected)
                MODULE.Desktop.combo(host, "W", "px")
                self.assertEqual(host.element._window, "px")
                self.assertEqual(host.element.actions, ["open", "{HOME}{ENTER}"])
        finally:
            MODULE.time.sleep = original_sleep


if __name__ == "__main__":
    unittest.main()
