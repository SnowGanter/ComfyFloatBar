"""Desktop worker for Gigapixel 8.3.x. No cloud renders, guessed screen coordinates or shell input.

UI Automation locates controls by live labels; OpenCV checks captured windows and optional
visual anchors. Unknown/ambiguous controls stop the job rather than apply guessed settings.
Each invocation receives trusted local configuration and a server-created job on stdin.
"""
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path


def emit(**data):
    print(json.dumps(data, ensure_ascii=True), flush=True)


def control_text(element):
    value = element.element_info.element.GetCurrentPropertyValue(30005)
    if not value:
        try:
            value = element.iface_text.DocumentRange.GetText(-1)
        except Exception:
            pass
    return value or ""


def combo_text(element):
    """Read a Qt combo value across Topaz UIA variants."""
    values = []
    for getter in (lambda: element.window_text(), lambda: control_text(element)):
        try:
            value = str(getter() or "").strip()
            if value:
                values.append(value)
        except Exception:
            pass
    # Some Qt versions expose the selected value only as a child Text. Do not
    # mix child entries into a non-empty direct value: an open combo can expose
    # every menu option as a descendant.
    if values:
        return " ".join(values)
    try:
        values.extend(str(child.window_text() or "") for child in element.descendants(control_type="Text"))
    except Exception:
        pass
    return " ".join(value.strip() for value in values if value.strip())


def combo_has_value(element, value):
    text = combo_text(element).casefold()
    wanted = str(value).strip().casefold()
    if wanted in ("px", "in", "cm"):
        return wanted in re.findall(r"[a-z]+", text)
    # Topaz may expose "Format: JPEG", "JPEG JPEG", or the plain value,
    # depending on the installed Qt/UIA build.
    return bool(re.search(r"(?<![\w])" + re.escape(wanted) + r"(?![\w])", text))


def wait_for(check, timeout=60, description="операция"):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            value = check()
            if value:
                return value
        except Exception as exc:
            last = exc
        time.sleep(1)
    raise RuntimeError(f"Не удалось дождаться: {description}" + (f" ({last})" if last else ""))


def activate_telegram_send(button, pending_attachment, waiter=wait_for):
    """Start one send, retrying only while the same attachment dialog is open.

    A real click is fastest for Telegram's Qt dialog. UIA Invoke is a fallback.
    Waiting for the dialog to close keeps that fallback safe: after Telegram
    accepts the first action, pending_attachment becomes false and no second send
    can be triggered.
    """
    failures = []
    # Telegram's Qt UI accepts a real click immediately, while UIA Invoke can
    # report success and leave the modal untouched for many seconds.
    for name, action in (("мышь", button.click_input), ("UI Automation", button.invoke)):
        if not pending_attachment():
            return name
        try:
            action()
        except Exception as exc:
            failures.append(f"{name}: {exc}")
            continue
        try:
            waiter(lambda: not pending_attachment(), 4, "начало отправки Telegram")
            return name
        except Exception as exc:
            failures.append(f"{name}: {exc}")
    if not pending_attachment():
        return "подтверждено"
    raise RuntimeError("Telegram не начал отправку после двух способов нажатия" +
                       (": " + "; ".join(failures) if failures else ""))


def output_pixels(settings, width, height):
    if settings["resizeMode"] == "scale":
        factor = settings["scale"]
    else:
        value = settings["dimension"]
        if settings["unit"] == "cm":
            value = value / 2.54 * settings["ppi"]
        elif settings["unit"] == "in":
            value *= settings["ppi"]
        factor = value / (width if settings["resizeMode"] == "width" else height)
    result = round(width * factor), round(height * factor)
    if factor < 1 or max(result) > 32000:
        raise ValueError("Размер Topaz должен быть не меньше исходника и не больше 32000 px")
    return result


def verified_image_dimensions(path):
    """Validate a trusted local source without Pillow's generic pixel ceiling."""
    from PIL import Image
    previous_limit = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(path) as image:
            image.verify()
        with Image.open(path) as image:
            return image.size
    finally:
        Image.MAX_IMAGE_PIXELS = previous_limit


class Desktop:
    def __init__(self, executable):
        import pywinauto
        import pyautogui
        import cv2
        import numpy
        import win32gui
        self.ui = pywinauto.Desktop(backend="uia")
        self.mouse = pyautogui
        self.cv = cv2
        self.np = numpy
        self.win32gui = win32gui
        self.executable = str(Path(executable).resolve())
        self.window = None
        self.ocr = None

    def visual_click(self, text):
        if self.ocr is None:
            from rapidocr_onnxruntime import RapidOCR
            self.ocr = RapidOCR()
        shot = self.capture()
        results, _ = self.ocr(shot)
        normalize = lambda value: re.sub(r"[^a-z0-9]", "", value.lower())
        wanted = [text] if isinstance(text, str) else text
        matches = [(box, float(score)) for box, value, score in (results or []) if normalize(value) in [normalize(t) for t in wanted] and float(score) > .8]
        if len(matches) != 1:
            raise RuntimeError(f"Компьютерное зрение не нашло однозначно «{text}» ({len(matches)})")
        # Recheck the image immediately before acting; an unrelated window must not receive input.
        current = self.capture()
        if current.shape != shot.shape or float(self.cv.absdiff(current, shot).mean()) > 4:
            raise RuntimeError("Окно изменилось во время распознавания. Повторите подготовку.")
        box = matches[0][0]
        rect = self.window.rectangle()
        self.mouse.click(rect.left + sum(p[0] for p in box) / 4, rect.top + sum(p[1] for p in box) / 4)
        time.sleep(.5)

    def connect(self, launch=False):
        import win32process
        import win32api
        def matching():
            found = []
            from pywinauto import Desktop as WinDesktop
            for native_window in WinDesktop(backend="win32").windows(visible_only=False):
                try:
                    # Match by the signed executable path. Telegram Desktop uses a
                    # TWidget top-level class while Gigapixel uses Qt classes.
                    if not native_window.window_text() or not native_window.is_visible():
                        continue
                    handle = win32api.OpenProcess(0x0410, False, native_window.process_id())
                    try:
                        exe = win32process.GetModuleFileNameEx(handle, 0)
                    finally:
                        handle.Close()
                    # GetModuleFileNameEx can replace non-ASCII profile characters
                    # on some Python/pywin32 builds. The configured executable must
                    # exist, and the single-window rule below still prevents an
                    # ambiguous same-name process from being controlled.
                    same_path = os.path.normcase(exe) == os.path.normcase(self.executable)
                    same_name = Path(exe).name.casefold() == Path(self.executable).name.casefold()
                    if same_path or same_name:
                        found.append(self.ui.window(handle=native_window.handle).wrapper_object())
                except Exception:
                    continue
            return found
        candidates = matching()
        if not candidates and launch:
            subprocess.Popen([self.executable], shell=False)
            candidates = wait_for(matching, 120, "запуск Topaz")
        visible_candidates = [w for w in candidates if w.is_visible()]
        if visible_candidates:
            candidates = visible_candidates
        if len(candidates) > 1:
            candidates.sort(key=lambda w: w.rectangle().width() * w.rectangle().height(), reverse=True)
            largest = candidates[0].rectangle().width() * candidates[0].rectangle().height()
            runner_up = candidates[1].rectangle().width() * candidates[1].rectangle().height()
            if largest > runner_up * 2:
                candidates = candidates[:1]
        if len(candidates) != 1:
            raise RuntimeError(f"Ожидалось одно окно приложения ({len(candidates)}). Закройте его диалоговые окна на сервере.")
        self.window = candidates[0]
        emit(progress="Окно приложения найдено; активация")
        foreground = self.win32gui.GetForegroundWindow()
        if foreground and self.win32gui.GetClassName(foreground) == "Windows.UI.Core.CoreWindow" and self.win32gui.GetWindowText(foreground).startswith(("Список переходов", "Jump List")):
            self.mouse.press("esc")
            time.sleep(.3)
        self.win32gui.ShowWindow(self.window.handle, 9)
        # UIA SetFocus doesn't reliably activate Qt top-level windows.
        from pywinauto import Desktop as WinDesktop
        try:
            WinDesktop(backend="win32").window(handle=self.window.handle).set_focus()
        except Exception:
            self.mouse.keyDown("alt")
            try:
                self.win32gui.SetForegroundWindow(self.window.handle)
            finally:
                self.mouse.keyUp("alt")
        wait_for(lambda: self.win32gui.GetForegroundWindow() == self.window.handle, 5, "фокус приложения")
        self.capture()
        emit(progress="Окно активно; проверка интерфейса")
        return self

    def capture(self):
        # A black/locked/occluded capture must never be treated as a successful UI step.
        foreground = self.win32gui.GetForegroundWindow()
        import win32process
        _, foreground_pid = win32process.GetWindowThreadProcessId(foreground)
        if foreground_pid != self.window.process_id():
            from pywinauto import Desktop as WinDesktop
            try:
                WinDesktop(backend="win32").window(handle=self.window.handle).set_focus()
                wait_for(lambda: win32process.GetWindowThreadProcessId(self.win32gui.GetForegroundWindow())[1] == self.window.process_id(), 5, "возврат фокуса приложения")
            except Exception as error:
                raise RuntimeError("Не удалось вернуть фокус в приложение. Задача остановлена.") from error
        rect = self.window.rectangle()
        shot = self.np.asarray(self.mouse.screenshot(region=(rect.left, rect.top, rect.width(), rect.height())))
        gray = self.cv.cvtColor(shot, self.cv.COLOR_RGB2GRAY)
        if gray.size == 0 or float(gray.std()) < 2:
            raise RuntimeError("Экран заблокирован или окно приложения не видно")
        return gray

    def elements(self, kind=None, include_disabled=False):
        self.capture()
        bounds = self.window.rectangle()
        values = self.window.descendants(control_type=kind) if kind else self.window.descendants()
        return [e for e in values if e.is_visible() and (include_disabled or kind == "Text" or e.is_enabled()) and e.rectangle().width() > 0 and e.rectangle().height() > 0
                and bounds.left <= e.rectangle().mid_point().x <= bounds.right
                and bounds.top <= e.rectangle().mid_point().y <= bounds.bottom]

    def named(self, text, kind=None):
        values = [e for e in self.elements(kind) if control_text(e).strip() == text]
        if len(values) > 1:
            panel_values = [e for e in values if ".ScrollView" in e.element_info.automation_id]
            if len(panel_values) == 1:
                values = panel_values
        if len(values) != 1:
            raise RuntimeError(f"Элемент «{text}» не найден однозначно ({len(values)})")
        return values[0]

    def click(self, text, kind="Button"):
        element = self.named(text, kind)
        element.click_input()
        time.sleep(.4)
        self.capture()

    def near(self, label, kind, include_disabled=False):
        label_element = self.named(label, "Text")
        rect = label_element.rectangle()
        choices = []
        for element in self.elements(kind, include_disabled):
            r = element.rectangle()
            # Adjacent fields share the label's row or lie directly below it in the same panel.
            distance = abs(r.top - rect.top)
            if r.bottom >= rect.top and r.top <= rect.bottom + 45 and r.left >= rect.left - 10:
                choices.append((distance + abs(r.left - rect.left) * .03, element))
        choices.sort(key=lambda x: x[0])
        if not choices or (len(choices) > 1 and abs(choices[0][0] - choices[1][0]) < 1):
            raise RuntimeError(f"Не найдено однозначное поле рядом с «{label}»")
        return choices[0][1]

    def set_field(self, label, value):
        element = self.near(label, "Edit")
        element.set_edit_text(str(value))
        element.type_keys("{TAB}")
        actual = self.near(label, "Edit").get_value().replace(",", ".")
        try:
            valid = abs(float(actual) - float(value)) < .02
        except ValueError:
            valid = actual.strip() == str(value).strip()
        if not valid:
            raise RuntimeError(f"Topaz не принял значение «{label}»: {actual}")

    def toggle(self, label, desired):
        element = self.near(label, "CheckBox", include_disabled=True)
        if not element.is_enabled():
            if not desired and not element.get_toggle_state():
                return
            raise RuntimeError(f"Topaz не позволяет включить «{label}» для этого изображения")
        if bool(element.get_toggle_state()) != bool(desired):
            element.click_input()
        if bool(self.near(label, "CheckBox").get_toggle_state()) != bool(desired):
            raise RuntimeError(f"Не удалось переключить {label}")

    def combo(self, label, value):
        element = self.near(label, "ComboBox")
        if not combo_has_value(element, value):
            element.click_input()
            time.sleep(.3)
            options = {
                "W": ["px", "in", "cm"],
                "H": ["px", "in", "cm"],
                "Format": ["Preserve input format", "JPEG", "PNG", "TIFF"],
                "Color space": ["sRGB IEC61966-2.1", "Adobe RGB (1998)", "ProPhoto RGB"],
            }.get(label)
            if not options or value not in options:
                raise RuntimeError(f"Нет безопасной схемы выбора «{label}: {value}»")
            # Prefer the actual visible popup item. Keyboard navigation remains
            # a deterministic fallback for Qt builds that do not expose items.
            combo_rect = element.rectangle()
            visible = []
            for candidate in self.elements("Text"):
                if control_text(candidate).strip() != value:
                    continue
                rect = candidate.rectangle()
                inside_combo = (combo_rect.left <= rect.mid_point().x <= combo_rect.right and
                                combo_rect.top <= rect.mid_point().y <= combo_rect.bottom)
                if not inside_combo and abs(rect.left - combo_rect.left) < 120 and abs(rect.top - combo_rect.top) < 500:
                    visible.append(candidate)
            if len(visible) == 1:
                visible[0].click_input()
            else:
                element.type_keys("{HOME}" + "{DOWN}" * options.index(value) + "{ENTER}")
            time.sleep(.3)
        if not combo_has_value(self.near(label, "ComboBox"), value):
            raise RuntimeError(f"Topaz не принял {label}: {value}")

    def open_file(self, filename, title_changes=True):
        self.capture()
        existing = self.file_dialog()
        if not existing:
            if title_changes:
                self.visual_click(["Browse images", "Add image"])
            else:
                attachments = [e for e in self.elements("Button") if "HistoryWidget.class Ui::IconButton" in e.element_info.automation_id and e.rectangle().left < self.window.rectangle().left + 600]
                if len(attachments) != 1:
                    raise RuntimeError("Не найдена кнопка вложения Telegram")
                attachments[0].click_input()
        emit(progress="Ожидание диалога выбора файла")
        dialog = wait_for(self.file_dialog, 15, "диалог открытия")
        dialog_spec = self.ui.window(handle=dialog.handle)
        edit = dialog_spec.child_window(auto_id="1148", control_type="ComboBox").child_window(control_type="Edit").wrapper_object()
        edit.set_edit_text(str(filename))
        dialog_spec.child_window(auto_id="1", control_type="Button").click_input()
        if title_changes:
            wait_for(lambda: Path(filename).name in self.window.window_text(), 120, "загрузка изображения")
        from pywinauto import Desktop as WinDesktop
        WinDesktop(backend="win32").window(handle=self.window.handle).set_focus()
        wait_for(lambda: self.win32gui.GetForegroundWindow() == self.window.handle, 5, "возврат в приложение после выбора файла")
        self.capture()

    def file_dialog(self):
        dialogs = self.window.descendants(class_name="#32770")
        if not dialogs:
            dialogs = self.ui.windows(process=self.window.process_id(), class_name="#32770")
        if not dialogs:
            from pywinauto import Desktop as WinDesktop
            native = [w for w in WinDesktop(backend="win32").windows(visible_only=True)
                      if w.process_id() == self.window.process_id() and w.class_name() == "#32770"]
            dialogs = [self.ui.window(handle=w.handle).wrapper_object() for w in native]
        return dialogs[0] if len(dialogs) == 1 else None


def release_comfy(config):
    import requests
    from urllib.parse import urlparse
    url = config.get("comfyUrl", "http://127.0.0.1:8188").rstrip("/")
    try:
        response = requests.get(url + "/queue", timeout=5)
        response.raise_for_status()
    except requests.ConnectionError:
        if urlparse(url).hostname in ("127.0.0.1", "localhost", "::1"):
            emit(progress="Локальный ComfyUI выключен; освобождение памяти пропущено")
            return
        raise
    emit(progress="Ожидание завершения очереди ComfyUI")
    def idle():
        response = requests.get(url + "/queue", timeout=10)
        response.raise_for_status()
        queue = response.json()
        return not queue.get("queue_running") and not queue.get("queue_pending")
    wait_for(idle, 15 * 60, "свободная очередь ComfyUI")
    requests.post(url + "/free", json={"unload_models": True, "free_memory": True}, timeout=60).raise_for_status()


def close_games(config):
    # Fixed allowlist. A remote job cannot supply process names or shell commands.
    if config.get("closeCS2", False):
        result = subprocess.run(["taskkill", "/F", "/IM", "cs2.exe"], capture_output=True, creationflags=0x08000000)
        if result.returncode not in (0, 128):
            raise RuntimeError("Не удалось закрыть CS2. Проверьте права обработчика.")


def desktop_hide(config, job):
    """Hide only currently visible ComfyFloatBar windows and remember their handles."""
    import win32api
    import win32gui
    import win32process
    handles = []
    def visit(handle, _):
        if not win32gui.IsWindowVisible(handle):
            return
        try:
            _, process_id = win32process.GetWindowThreadProcessId(handle)
            process_handle = win32api.OpenProcess(0x0410, False, process_id)
            try:
                executable = win32process.GetModuleFileNameEx(process_handle, 0)
            finally:
                process_handle.Close()
            if Path(executable).name.casefold() == "comfyfloatbar.exe":
                handles.append(int(handle))
                win32gui.ShowWindow(handle, 0)
        except Exception:
            pass
    win32gui.EnumWindows(visit, None)
    time.sleep(.25)
    return {"handles": handles}


def desktop_restore(config, job):
    """Restore exactly the FloatBar windows hidden for this job without taking focus."""
    import win32gui
    restored = 0
    for raw_handle in job.get("hiddenWindowHandles", []):
        handle = int(raw_handle)
        if win32gui.IsWindow(handle):
            win32gui.ShowWindow(handle, 4)
            restored += 1
    return {"restored": restored}


def topaz(config):
    return Desktop(config.get("topazExe", r"C:\Program Files\Topaz Labs LLC\Topaz Gigapixel AI\Topaz Gigapixel AI.exe"))


def prepare(config, job):
    width, height = verified_image_dimensions(job["input"])
    release_comfy(config)
    close_games(config)
    emit(progress="Запуск Topaz и открытие исходного изображения")
    app = topaz(config).connect(launch=True)
    completed = [e for e in app.elements("Button") if control_text(e) == "Close window"]
    if len(completed) == 1:
        completed[0].click_input()
        time.sleep(.5)
    # Existing export dialogs are user work; don't silently cancel or confirm them.
    if any(control_text(e) == "Export settings" and e.is_enabled() for e in app.elements("Text")):
        raise RuntimeError("В Topaz открыто окно экспорта. Завершите или закройте его на сервере.")
    for checkbox in app.elements("CheckBox"):
        if ".OpenFileDelegate" in checkbox.element_info.automation_id and checkbox.get_toggle_state():
            checkbox.click_input()
    app.open_file(job["input"])
    wait_for(lambda: app.named("Upscale", "Text"), 60, "готовность настроек Topaz")
    return {"width": width, "height": height}


def process(config, job):
    from PIL import Image
    app = topaz(config).connect()
    if Path(job["input"]).name not in app.window.window_text():
        raise RuntimeError("В Topaz открыта другая картинка. Повторно загрузите задачу.")
    # A completed export leaves a confirmation sheet over the model settings.
    # Close only that sheet when it belongs to the current CFB image.
    completed = [e for e in app.elements("Button") if control_text(e) == "Close window"]
    if completed:
        if len(completed) != 1 or not any("CFB_" + job["id"] in control_text(e) for e in app.elements("Text")):
            raise RuntimeError("В Topaz открыто чужое окно завершённого экспорта")
        completed[0].click_input()
        time.sleep(.5)
    existing_dialog = app.file_dialog()
    if existing_dialog and existing_dialog.window_text() in ("Выбор папки", "Select Folder"):
        app.ui.window(handle=existing_dialog.handle).child_window(auto_id="2", control_type="Button").click_input()
        time.sleep(.3)
    exports = [e for e in app.elements("Text") if ".ExportFileDelegate" in e.element_info.automation_id and re.search(r"\.(png|jpeg|jpg|tif|tiff)$", control_text(e), re.I)]
    if exports and all("CFB_" + job["id"] in control_text(e) for e in exports):
        cancel_buttons = [e for e in app.elements("Button") if control_text(e) == "Cancel" and ".Pane_" not in e.element_info.automation_id]
        if len(cancel_buttons) == 1:
            cancel_buttons[0].click_input()
            time.sleep(.4)
    settings = job["settings"]
    width, height = output_pixels(settings, job["width"], job["height"])
    # Select model by the actual visible label. If the settings page is open, its back
    # button is the sole unlabelled button immediately before the model title.
    texts = app.elements("Text")
    if not any(control_text(e) == "Select a model" for e in texts):
        titles = [e for e in texts if ".StackView" in e.element_info.automation_id and control_text(e) in ("Standard v2", "High fidelity v2", "Low res v2", "Text & shapes", "Art & CG", "Recover", "Recover v2", "Redefine")]
        if len(titles) != 1:
            raise RuntimeError("Не удалось определить страницу модели Topaz")
        r = titles[0].rectangle()
        buttons = [e for e in app.elements("Button") if not control_text(e) and abs(e.rectangle().top-r.top)<20 and e.rectangle().right <= r.left]
        if len(buttons) != 1:
            raise RuntimeError("Не найдена кнопка возврата к моделям")
        buttons[0].click_input()
        time.sleep(.4)
    model_label = "Recover" if settings["model"] == "Recover v2" else settings["model"]
    model_targets = [e for e in app.elements("Text") if ".StackView" in e.element_info.automation_id and control_text(e) == model_label]
    if len(model_targets) != 1:
        raise RuntimeError(f"Модель «{model_label}» не найдена в списке Topaz ({len(model_targets)})")
    model_targets[0].click_input()
    time.sleep(.5)
    app.set_field("Pixel density", settings["ppi"])
    # Pixel input avoids locale dependent inches and cm; physical sizes are converted above.
    app.combo("W", "px")
    app.set_field("W", width)
    if abs(float(app.near("H", "Edit").get_value().replace(",", ".")) - height) > 1:
        raise RuntimeError("Topaz изменил пропорции изображения")
    if settings["model"] == "Recover v2":
        app.click("v2")
        app.set_field("Detail", settings["detail"])
        app.toggle("Face recovery", settings["face"])
    elif settings["model"] == "Redefine":
        app.set_field("Creativity", settings["creativity"])
        app.toggle("Advanced settings", True)
        for label, key in [("Texture", "texture"), ("Extra sharpen", "extraSharpen"), ("Extra denoise", "extraDenoise"), ("Image description", "description")]:
            app.set_field(label, settings[key])
    else:
        for label, key in [("Sharpen", "sharpen"), ("Denoise", "denoise"), ("Fix compression", "compression")]:
            if key == "compression" and settings["model"] == "Art & CG":
                continue
            app.set_field(label, settings[key])
        app.toggle("Face recovery", settings["face"])
        app.toggle("Gamma correction", settings["gamma"])
    output_dir = Path(job["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    if list(output_dir.iterdir()):
        raise RuntimeError("Папка результата уже содержит файлы: повторный экспорт остановлен")
    app.click("Export image")
    app.named("Export settings", "Text")
    # All selected exports must belong to this job, never another open user image.
    exports = [control_text(e) for e in app.elements("Text") if ".ExportFileDelegate" in e.element_info.automation_id and re.search(r"\.(png|jpeg|jpg|tif|tiff)$", control_text(e), re.I)]
    if not exports or any("CFB_" + job["id"] not in text for text in exports):
        raise RuntimeError("В очередь экспорта Topaz попало другое изображение. Снимите его выделение.")
    app.set_field("Prefix:", "")
    app.set_field("Suffix:", "")
    app.toggle("Add applied filters to filename", False)
    # Editable output path in Gigapixel. Unsupported UI variants stop with an explicit error.
    destination = app.near("Save to", "ComboBox")
    expected_destination = os.path.normcase(str(output_dir).replace('\\', '/'))
    actual_destination = os.path.normcase(destination.window_text().replace('\\', '/'))
    if actual_destination != expected_destination:
        destination.click_input()
        destination.type_keys("{END}{ENTER}")
        dialog = wait_for(app.file_dialog, 15, "выбор папки результата")
        dialog_spec = app.ui.window(handle=dialog.handle)
        filename = dialog_spec.child_window(auto_id="1152", control_type="Edit").wrapper_object()
        filename.set_edit_text(str(output_dir))
        dialog_spec.child_window(auto_id="1", control_type="Button").click_input()
        wait_for(lambda: app.win32gui.GetForegroundWindow() == app.window.handle, 5, "возврат из выбора папки")
        destination = app.near("Save to", "ComboBox")
    if os.path.normcase(destination.window_text().replace('/', '\\')) != os.path.normcase(str(output_dir)):
        raise RuntimeError("Topaz не подтвердил папку сохранения")
    app.combo("Format", settings["format"])
    if settings["format"] == "JPEG":
        app.set_field("Quality", settings["quality"])
    app.combo("Color space", settings["colorSpace"])
    app.click("Save")
    emit(progress="Topaz обрабатывает изображение. Ожидание готового файла…")
    deadline = time.monotonic() + 23 * 60 * 60
    previous = None
    stable_since = time.monotonic()
    while time.monotonic() < deadline:
        completed = any(control_text(e) in ("Close window", "Закрыть окно")
                        for e in app.window.descendants(control_type="Button") if e.is_visible())
        candidates = [p for p in output_dir.iterdir() if p.suffix.lower() in (".png", ".jpg", ".jpeg", ".tif", ".tiff")]
        if len(candidates) > 1:
            raise RuntimeError("Topaz сохранил несколько файлов вместо одного")
        if candidates:
            result = candidates[0]
            stat = result.stat()
            signature = (stat.st_size, stat.st_mtime_ns)
            if signature != previous:
                previous = signature
                stable_since = time.monotonic()
            elif completed and stat.st_size > 0 and time.monotonic() - stable_since > 5:
                try:
                    # The output may legitimately contain hundreds of millions of
                    # pixels (for example 213 inches at 150 PPI). Read only its
                    # header here; decoding the entire image wastes RAM and trips
                    # Pillow's generic decompression-bomb guard on valid exports.
                    previous_limit = Image.MAX_IMAGE_PIXELS
                    Image.MAX_IMAGE_PIXELS = None
                    try:
                        with Image.open(result) as image:
                            if image.format not in ("PNG", "JPEG", "TIFF"):
                                raise RuntimeError("Topaz сохранил неподдерживаемый формат")
                            if abs(image.width-width)>1 or abs(image.height-height)>1:
                                raise RuntimeError("Размер результата не совпадает с выбранным")
                    finally:
                        Image.MAX_IMAGE_PIXELS = previous_limit
                    # On Windows sharing violations protect an export still held open by Topaz.
                    import win32file
                    handle = win32file.CreateFile(str(result), 0x80000000, 0, None, 3, 0, None)
                    handle.Close()
                    return {"path": str(result), "fileName": result.name}
                except (OSError, ValueError):
                    pass
        time.sleep(5)
    raise RuntimeError("Topaz не завершил экспорт за 23 часа")


def telegram(config, job):
    result = Path(job["resultPath"]).resolve()
    if result.parent != Path(job["outputDir"]).resolve() or not result.is_file():
        raise RuntimeError("Некорректный файл результата")
    if result.stat().st_size > 2_000_000_000:
        raise RuntimeError("Результат больше 2 ГБ. Он сохранён на сервере, отправка остановлена.")
    app = Desktop(config["telegramExe"]).connect(launch=True)
    expected = config.get("telegramTitle", "Избранное")
    saved_title = None
    # Require the Saved Messages chat and the configured account, not search-result text.
    def correct_chat():
        title = re.sub(r"[\u200e\u200f]", "", app.window.window_text()).strip()
        named_saved = title.startswith(expected)
        shortcut_saved = saved_title is not None and title == saved_title
        return (named_saved or shortcut_saved) and (not config.get("telegramAccount") or config["telegramAccount"] in title)
    if not correct_chat():
        previous_title = re.sub(r"[\u200e\u200f]", "", app.window.window_text()).strip()
        # Telegram Desktop's documented Ctrl+0 shortcut opens Saved Messages.
        app.mouse.hotkey("ctrl", "0")
        def saved_opened():
            nonlocal saved_title
            title = re.sub(r"[\u200e\u200f]", "", app.window.window_text()).strip()
            account_ok = not config.get("telegramAccount") or config["telegramAccount"] in title
            if title and title != previous_title and account_ok:
                saved_title = title
                return True
            return False
        wait_for(saved_opened, 10, "переход в Избранное Telegram")
    def is_result_label(element):
        label = control_text(element).strip()
        if result.name in label:
            return True
        # Telegram visually and accessibly shortens long UUID filenames with an
        # ellipsis, while preserving the beginning and extension.
        return label.startswith(result.name[:12]) and label.lower().endswith(result.suffix.lower())
    def result_visible_by_ocr():
        if app.ocr is None:
            from rapidocr_onnxruntime import RapidOCR
            app.ocr = RapidOCR()
        results, _ = app.ocr(app.capture())
        stem = result.stem.lower()
        for _, value, score in (results or []):
            text = str(value).lower()
            if float(score) > .75 and stem[:11] in text and stem[-6:] in text and result.suffix.lower() in text:
                return True
        return False
    existing_elements = app.elements()
    existing_modal = any("Ui::BoxLayerWidget" in e.element_info.automation_id for e in existing_elements)
    existing_result = any(is_result_label(e) and "Ui::BoxLayerWidget" in e.element_info.automation_id for e in existing_elements)
    if existing_modal and not existing_result:
        existing_result = result_visible_by_ocr()
    if existing_modal and not existing_result:
        raise RuntimeError("В Telegram уже открыто другое вложение. Оно не было изменено.")
    # Ctrl+O opens attachment-as-file, unlike pasting bitmap data (which recompresses photos).
    if not existing_result:
        try:
            app.open_file(result, title_changes=False)
        except RuntimeError as error:
            if "диалог открытия" not in str(error):
                raise
            # Telegram may ignore the first attachment click while a side panel or
            # animation is closing. Return focus, dismiss the transient layer and retry.
            app.mouse.press("esc")
            from pywinauto import Desktop as WinDesktop
            WinDesktop(backend="win32").window(handle=app.window.handle).set_focus()
            wait_for(lambda: app.win32gui.GetForegroundWindow() == app.window.handle, 5, "возврат в Telegram")
            app.open_file(result, title_changes=False)
    if not correct_chat():
        raise RuntimeError("Чат Telegram изменился перед отправкой")
    elements = app.elements()
    labels = [control_text(e) for e in elements]
    attachment_checks = [e for e in elements if e.element_info.control_type == "CheckBox" and "Ui::BoxLayerWidget" in e.element_info.automation_id]
    attachment_named = any(is_result_label(e) and "Ui::BoxLayerWidget" in e.element_info.automation_id for e in elements)
    if not attachment_named and not attachment_checks and not result_visible_by_ocr():
        raise RuntimeError("Telegram не подтвердил вложение")
    # Images must be sent as files so Telegram does not recompress an upscale.
    if attachment_checks:
        send_as_file = min(attachment_checks, key=lambda e: e.rectangle().top)
        if not send_as_file.get_toggle_state():
            send_as_file.click_input()
    for label in ("Сжать изображения", "Compress images"):
        if label in labels:
            app.toggle(label, False)
    buttons = [e for e in app.elements("Button") if control_text(e) in ("Отправить", "Send")]
    if len(buttons) != 1:
        modal_buttons = [e for e in app.elements("Button") if "Ui::BoxLayerWidget" in e.element_info.automation_id and "Ui::RoundButton" in e.element_info.automation_id]
        buttons = [max(modal_buttons, key=lambda e: e.rectangle().left)] if modal_buttons else []
    if len(buttons) != 1:
        raise RuntimeError("Не найдена однозначная кнопка отправки Telegram")
    # Use Telegram's UI Automation action first. If Telegram silently ignores it,
    # retry with a physical click only while this exact attachment modal remains.
    send_button = buttons[0]
    def attachment_pending():
        if not correct_chat():
            return False
        # The attachment identity was already verified above. A fast modal check
        # avoids running OCR on every retry tick.
        return any("Ui::BoxLayerWidget" in e.element_info.automation_id
                   for e in app.window.descendants() if e.is_visible())
    activate_telegram_send(send_button, attachment_pending)
    def sent_completely():
        if not correct_chat(): return False
        # Inspect the UIA tree without capture(), which would repeatedly force
        # Telegram to the foreground during a long upload.
        elements = [e for e in app.window.descendants() if e.is_visible()]
        delivered = [e for e in elements if is_result_label(e) and "Ui::BoxLayerWidget" not in e.element_info.automation_id]
        modal_open = any("Ui::BoxLayerWidget" in e.element_info.automation_id for e in elements)
        uploading = any(e.element_info.control_type == "ProgressBar" for e in elements)
        return bool(delivered) and not modal_open and not uploading
    wait_for(sent_completely, 3*60*60, "полное завершение отправки Telegram")
    return {"sent": True}


if __name__ == "__main__":
    try:
        # Windows assigns the active ANSI code page to redirected stdin. Node
        # always writes JSON as UTF-8, so decode the bytes explicitly to keep
        # Cyrillic profile paths (for example C:\\Users\\Илья) intact.
        payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
        operation = {"desktop-hide": desktop_hide, "desktop-restore": desktop_restore,
                     "prepare": prepare, "process": process, "telegram": telegram}[sys.argv[1]]
        emit(result=operation(payload["config"], payload["job"]))
    except Exception as exc:
        emit(error=str(exc))
        sys.exit(1)
