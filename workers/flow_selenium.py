import base64
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

import requests
from selenium import webdriver
from selenium.common.exceptions import TimeoutException, WebDriverException
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait


# Force UTF-8 for Windows consoles/log pipes (notably Python 3.14 + cp1252).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

HOST = "127.0.0.1"
FLOW_PROTOCOL = 3
BRIDGE_URL = os.getenv("FLOW_BRIDGE_URL", "http://127.0.0.1:7865")
PORT = int(urlparse(BRIDGE_URL).port or 7865)
PROJECT_URL = os.getenv("FLOW_PROJECT_URL", "https://flow.google.com/")
MODEL_LABEL = os.getenv("FLOW_MODEL_LABEL", "Nano Banana Pro")
PROFILE_DIR = pathlib.Path(os.getenv("FLOW_PROFILE_DIR", "data/flow-selenium-profile")).resolve()
DIAG_DIR = pathlib.Path("data/flow-diagnostics").resolve()
TIMEOUT_SECONDS = int(os.getenv("FLOW_GENERATION_TIMEOUT_MS", "420000")) // 1000
BROWSER_MODE = os.getenv("FLOW_BROWSER_MODE", "minimized").strip().lower()
WAIT_SECONDS = int(os.getenv("FLOW_UI_WAIT_SECONDS", "45"))
COOLDOWN_SECONDS = float(os.getenv("FLOW_COOLDOWN_SECONDS", "3"))

def default_chrome_user_data():
    if os.name == "nt":
        base = os.getenv("LOCALAPPDATA", "")
        if base:
            return pathlib.Path(base) / "Google" / "Chrome" / "User Data"
    if sys.platform == "darwin":
        return pathlib.Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
    return pathlib.Path.home() / ".config" / "google-chrome"

CHROME_USER_DATA_DIR = pathlib.Path(
    os.getenv("FLOW_CHROME_USER_DATA_DIR", str(default_chrome_user_data()))
).resolve()
SELECTION_FILE = pathlib.Path("data/flow-profile-selection.json").resolve()
CLONE_BASE_DIR = pathlib.Path(
    os.getenv("FLOW_PROFILE_CLONE_DIR", "data/flow-chrome-clones")
).resolve()
CLONE_BASE_DIR.mkdir(parents=True, exist_ok=True)

def load_profile_selection():
    try:
        data = json.loads(SELECTION_FILE.read_text(encoding="utf-8"))
        mode = data.get("mode") if data.get("mode") in ("storyflow", "chrome") else "storyflow"
        directory = str(data.get("profileDirectory") or "Default")
        return {"mode": mode, "profileDirectory": directory}
    except Exception:
        return {"mode": "storyflow", "profileDirectory": "Default"}

_profile_selection = load_profile_selection()

def save_profile_selection(mode, profile_directory):
    global _profile_selection
    _profile_selection = {
        "mode": mode if mode in ("storyflow", "chrome") else "storyflow",
        "profileDirectory": profile_directory or "Default",
    }
    SELECTION_FILE.parent.mkdir(parents=True, exist_ok=True)
    SELECTION_FILE.write_text(
        json.dumps(_profile_selection, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

def chrome_profiles():
    results = [{
        "id": "storyflow",
        "mode": "storyflow",
        "directory": "",
        "name": "StoryFlow riêng",
        "email": "",
        "recommended": True,
    }]
    local_state = CHROME_USER_DATA_DIR / "Local State"
    try:
        state = json.loads(local_state.read_text(encoding="utf-8"))
        cache = state.get("profile", {}).get("info_cache", {})
        for directory, info in cache.items():
            if not isinstance(info, dict):
                continue
            results.append({
                "id": f"chrome:{directory}",
                "mode": "chrome",
                "directory": directory,
                "name": str(info.get("name") or directory),
                "email": str(info.get("user_name") or ""),
                "recommended": False,
            })
    except Exception:
        pass
    return results

PROFILE_DIR.mkdir(parents=True, exist_ok=True)
DIAG_DIR.mkdir(parents=True, exist_ok=True)

_driver = None
_browser_process = None
_browser_debug_port = None
_driver_lock = threading.RLock()
_generate_lock = threading.Lock()
_state_lock = threading.Lock()
_state = {
    "active": False,
    "queued": 0,
    "lastError": "",
    "lastPrompt": "",
    "lastCompletedAt": "",
}


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")


def flow_host(url):
    try:
        return urlparse(url).hostname == "flow.google.com"
    except Exception:
        return False


def _safe_name(value):
    cleaned = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in value)
    return cleaned.strip("_") or "Default"


def _profile_clone_root(profile_directory):
    return CLONE_BASE_DIR / _safe_name(profile_directory) / "User Data"


def _copy_profile_once(profile_directory):
    clone_root = _profile_clone_root(profile_directory)
    marker = clone_root.parent / ".storyflow-clone.json"
    if marker.exists() and (clone_root / profile_directory).exists():
        return clone_root

    source_profile = CHROME_USER_DATA_DIR / profile_directory
    if not source_profile.exists():
        raise RuntimeError(
            f"Không tìm thấy thư mục Chrome profile: {profile_directory}"
        )

    clone_root.mkdir(parents=True, exist_ok=True)

    # Local State contains Chrome's local encryption metadata; copy it so an
    # existing signed-in session can be reused when Windows permits reading it.
    try:
        shutil.copy2(CHROME_USER_DATA_DIR / "Local State", clone_root / "Local State")
    except Exception:
        pass

    skip_dirs = {
        "Cache",
        "Code Cache",
        "GPUCache",
        "GrShaderCache",
        "DawnCache",
        "ShaderCache",
        "Crashpad",
        "BrowserMetrics",
        "OptimizationGuidePredictionModels",
        "GraphiteDawnCache",
        "Safe Browsing",
        "component_crx_cache",
    }
    skip_files = {
        "LOCK",
        "SingletonLock",
        "SingletonCookie",
        "SingletonSocket",
    }
    target_profile = clone_root / profile_directory
    target_profile.mkdir(parents=True, exist_ok=True)

    for root, dirs, files in os.walk(source_profile):
        dirs[:] = [name for name in dirs if name not in skip_dirs]
        src_root = pathlib.Path(root)
        relative = src_root.relative_to(source_profile)
        dst_root = target_profile / relative
        dst_root.mkdir(parents=True, exist_ok=True)
        for name in files:
            if name in skip_files or name.startswith("Singleton"):
                continue
            src = src_root / name
            dst = dst_root / name
            try:
                shutil.copy2(src, dst)
            except OSError:
                # Active Chrome may temporarily lock a few databases. The clone
                # remains usable; if the Google session is missing, the user
                # signs in once inside this isolated StoryFlow clone.
                continue

    marker.write_text(
        json.dumps(
            {
                "sourceUserData": str(CHROME_USER_DATA_DIR),
                "sourceProfile": profile_directory,
                "createdAt": now_iso(),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return clone_root


def _find_chrome_binary():
    configured = os.getenv("FLOW_CHROME_PATH", "").strip()
    candidates = []
    if configured:
        candidates.append(pathlib.Path(configured))
    if os.name == "nt":
        for base in (
            os.getenv("PROGRAMFILES", ""),
            os.getenv("PROGRAMFILES(X86)", ""),
            os.getenv("LOCALAPPDATA", ""),
        ):
            if base:
                candidates.append(
                    pathlib.Path(base) / "Google" / "Chrome" / "Application" / "chrome.exe"
                )
    elif sys.platform == "darwin":
        candidates.append(
            pathlib.Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        )
    else:
        for name in ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser"):
            found = shutil.which(name)
            if found:
                candidates.append(pathlib.Path(found))

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    raise RuntimeError(
        "Không tìm thấy Google Chrome. Có thể đặt FLOW_CHROME_PATH trong .env.local."
    )


def _free_debug_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _launch_browser_for_selection(visible, target_url):
    global _browser_process, _browser_debug_port

    mode = _profile_selection.get("mode", "storyflow")
    profile_directory = _profile_selection.get("profileDirectory", "Default")
    if mode == "chrome":
        user_data_root = _copy_profile_once(profile_directory)
    else:
        user_data_root = PROFILE_DIR
        profile_directory = "Default"

    debug_port = _free_debug_port()
    chrome = _find_chrome_binary()
    wanted = target_url if flow_host(target_url) else PROJECT_URL

    args = [
        chrome,
        f"--remote-debugging-port={debug_port}",
        f"--user-data-dir={user_data_root}",
        f"--profile-directory={profile_directory}",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-notifications",
        "--disable-popup-blocking",
        "--window-size=1600,1000",
    ]
    if not visible and BROWSER_MODE == "headless":
        args.append("--headless=new")
    elif not visible and BROWSER_MODE == "minimized":
        args.append("--start-minimized")
    args.append(wanted)

    creationflags = 0
    if os.name == "nt":
        creationflags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)

    _browser_process = subprocess.Popen(
        args,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=creationflags,
    )
    _browser_debug_port = debug_port

    deadline = time.time() + 20
    version_url = f"http://127.0.0.1:{debug_port}/json/version"
    while time.time() < deadline:
        if _browser_process.poll() is not None:
            raise RuntimeError(
                "Chrome Flow vừa mở đã tự đóng. Hãy thử lại hoặc kiểm tra FLOW_CHROME_PATH."
            )
        try:
            response = requests.get(version_url, timeout=1)
            if response.ok:
                break
        except Exception:
            pass
        time.sleep(0.25)
    else:
        raise RuntimeError("Không kết nối được cổng điều khiển Chrome Flow cục bộ.")

    options = webdriver.ChromeOptions()
    options.add_experimental_option("debuggerAddress", f"127.0.0.1:{debug_port}")
    try:
        return webdriver.Chrome(options=options)
    except WebDriverException as exc:
        try:
            _browser_process.terminate()
        except Exception:
            pass
        _browser_process = None
        _browser_debug_port = None
        raise RuntimeError(
            "Chrome đã mở nhưng Selenium không thể gắn vào phiên Flow cục bộ."
        ) from exc


def close_driver():
    global _driver, _browser_process, _browser_debug_port
    with _driver_lock:
        if _driver is not None:
            try:
                _driver.quit()
            except Exception:
                pass
            _driver = None
        if _browser_process is not None:
            try:
                if _browser_process.poll() is None:
                    _browser_process.terminate()
                    _browser_process.wait(timeout=3)
            except Exception:
                try:
                    _browser_process.kill()
                except Exception:
                    pass
            _browser_process = None
        _browser_debug_port = None


def ensure_driver(visible=False, target_url=None):
    global _driver
    with _driver_lock:
        if _driver is not None:
            try:
                _ = _driver.current_url
            except Exception:
                close_driver()

        if _driver is None:
            _driver = _launch_browser_for_selection(
                visible=visible,
                target_url=target_url or PROJECT_URL,
            )

        driver = _driver
        wanted = target_url or PROJECT_URL
        if not flow_host(wanted):
            wanted = PROJECT_URL
        current = driver.current_url or ""
        if not flow_host(current) and "accounts.google.com" not in current:
            driver.get(wanted)
        elif flow_host(wanted) and PROJECT_URL != "https://flow.google.com/":
            if not current.startswith(PROJECT_URL):
                driver.get(PROJECT_URL)

        if not visible and BROWSER_MODE == "minimized":
            try:
                driver.minimize_window()
            except Exception:
                pass
        return driver


def visible_prompt_box(driver):
    selectors = [
        (By.CSS_SELECTOR, 'textarea[placeholder*="Bạn muốn tạo"]'),
        (By.CSS_SELECTOR, 'textarea[placeholder*="What do you want"]'),
        (By.CSS_SELECTOR, '[contenteditable="true"][role="textbox"]'),
        (By.CSS_SELECTOR, 'textarea'),
        (By.CSS_SELECTOR, '[contenteditable="true"]'),
    ]
    for by, selector in selectors:
        try:
            elements = driver.find_elements(by, selector)
        except Exception:
            continue
        for element in reversed(elements):
            try:
                if element.is_displayed() and element.is_enabled():
                    return element
            except Exception:
                continue
    return None


def wait_prompt_box(driver):
    deadline = time.time() + WAIT_SECONDS
    while time.time() < deadline:
        box = visible_prompt_box(driver)
        if box is not None:
            return box
        if "accounts.google.com" in (driver.current_url or ""):
            raise RuntimeError(
                "Google Flow yêu cầu đăng nhập. Bấm Kết nối Flow và đăng nhập thủ công một lần."
            )
        time.sleep(0.5)
    raise TimeoutException(
        "Không tìm thấy ô nhập prompt. Hãy mở đúng project Google Flow rồi thử lại."
    )


def try_set_aspect(driver, aspect):
    # Best effort only. If Flow changes its UI, keep the project's current setting.
    xpaths = [
        f"//*[normalize-space(text())='{aspect}']",
        f"//button[normalize-space(.)='{aspect}']",
    ]
    for xpath in xpaths:
        try:
            elements = driver.find_elements(By.XPATH, xpath)
            for item in reversed(elements):
                if item.is_displayed() and item.is_enabled():
                    item.click()
                    return True
        except Exception:
            pass
    return False


def submit_prompt(driver, prompt, aspect):
    box = wait_prompt_box(driver)
    try:
        box.click()
    except Exception:
        driver.execute_script("arguments[0].click();", box)

    box.send_keys(Keys.CONTROL, "a")
    box.send_keys(Keys.BACKSPACE)
    box.send_keys(prompt)
    time.sleep(0.35)
    try_set_aspect(driver, aspect)

    # Prefer an explicit send/generate button. Enter is only the fallback.
    patterns = ["Tạo", "Generate", "Gửi", "Send"]
    for text in patterns:
        xpath = (
            "//button[not(@disabled) and "
            f"(contains(normalize-space(.), '{text}') or @aria-label='{text}')]"
        )
        try:
            candidates = driver.find_elements(By.XPATH, xpath)
            for button in reversed(candidates):
                if button.is_displayed() and button.is_enabled():
                    button.click()
                    return
        except Exception:
            pass

    box.send_keys(Keys.RETURN)


def large_image_sources(driver):
    script = """
    return Array.from(document.images)
      .filter(img => img.complete && img.naturalWidth >= 512 &&
                     img.naturalHeight >= 512 && (img.currentSrc || img.src))
      .map(img => ({
        src: img.currentSrc || img.src,
        width: img.naturalWidth,
        height: img.naturalHeight,
        alt: img.alt || ""
      }));
    """
    try:
        return driver.execute_script(script) or []
    except Exception:
        return []


def page_message(driver):
    try:
        text = driver.find_element(By.TAG_NAME, "body").text.lower()
    except Exception:
        return ""
    phrases = [
        "hết tín dụng",
        "tín dụng google flow",
        "credits",
        "rate limit",
        "too many requests",
        "thử lại sau",
        "try again later",
    ]
    for phrase in phrases:
        if phrase in text:
            return phrase
    return ""


def wait_new_image(driver, before):
    known = {item.get("src") for item in before if item.get("src")}
    deadline = time.time() + TIMEOUT_SECONDS
    while time.time() < deadline:
        current_url = driver.current_url or ""
        if "accounts.google.com" in current_url:
            raise RuntimeError(
                "Phiên Google Flow cần đăng nhập lại. Bấm Kết nối Flow để xác nhận."
            )
        current = large_image_sources(driver)
        fresh = [item for item in current if item.get("src") not in known]
        if fresh:
            return fresh[-1]

        message = page_message(driver)
        if message:
            raise RuntimeError(
                "Google Flow đang báo giới hạn/tín dụng: " + message
            )
        time.sleep(1.5)
    raise TimeoutError(
        "Flow chưa trả ảnh trong thời gian chờ. Tài nguyên đã tạo trước đó vẫn được giữ; "
        "hãy kiểm tra Flow rồi chạy lại riêng video này."
    )


def browser_fetch_base64(driver, src):
    script = """
    const url = arguments[0];
    const done = arguments[arguments.length - 1];
    fetch(url)
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      })
      .then(blob => {
        const reader = new FileReader();
        reader.onload = () => done({ok:true, value:String(reader.result)});
        reader.onerror = () => done({ok:false, error:String(reader.error)});
        reader.readAsDataURL(blob);
      })
      .catch(err => done({ok:false, error:String(err)}));
    """
    result = driver.execute_async_script(script, src)
    if not result or not result.get("ok"):
        raise RuntimeError(result.get("error", "Không đọc được ảnh trong Flow."))
    value = result.get("value", "")
    comma = value.find(",")
    if comma < 0:
        raise RuntimeError("Ảnh Flow không có dữ liệu base64 hợp lệ.")
    return base64.b64decode(value[comma + 1 :])


def fetch_image(driver, src):
    if src.startswith("data:image/"):
        comma = src.find(",")
        if comma < 0:
            raise RuntimeError("Data URL ảnh không hợp lệ.")
        return base64.b64decode(src[comma + 1 :])

    # First read inside the authenticated page. This does not export Google
    # cookies/tokens to StoryFlow; the browser performs its normal fetch.
    try:
        data = browser_fetch_base64(driver, src)
        if len(data) > 10_000:
            return data
    except Exception:
        pass

    # Signed googleusercontent/storage URLs are often directly downloadable.
    response = requests.get(src, timeout=90)
    response.raise_for_status()
    if len(response.content) < 10_000:
        raise RuntimeError("Ảnh Flow tải về quá nhỏ hoặc không hợp lệ.")
    return response.content


def mime_for(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"


def diagnostic(driver, label):
    stamp = time.strftime("%Y%m%d-%H%M%S")
    try:
        driver.save_screenshot(str(DIAG_DIR / f"{stamp}-{label}.png"))
    except Exception:
        pass
    try:
        (DIAG_DIR / f"{stamp}-{label}.html").write_text(
            driver.page_source, encoding="utf-8"
        )
    except Exception:
        pass


def connected_health():
    driver = None
    with _driver_lock:
        driver = _driver
    current_url = ""
    title = ""
    browser_open = False
    connected = False
    if driver is not None:
        try:
            current_url = driver.current_url or ""
            title = driver.title or ""
            browser_open = True
            connected = flow_host(current_url) and "accounts.google.com" not in current_url
        except Exception:
            browser_open = False

    with _state_lock:
        state = dict(_state)
    return {
        "status": "ok",
        "engine": "flow",
        "bridgeReady": True,
        "protocol": FLOW_PROTOCOL,
        "browserOpen": browser_open,
        "connected": connected,
        "projectConfigured": bool(os.getenv("FLOW_PROJECT_URL", "")),
        "currentUrl": current_url or None,
        "title": title or None,
        "model": MODEL_LABEL,
        "profileMode": _profile_selection.get("mode", "storyflow"),
        "profileDirectory": _profile_selection.get("profileDirectory", "Default"),
        "active": state["active"],
        "queued": state["queued"],
        "lastError": state["lastError"],
        "lastCompletedAt": state["lastCompletedAt"],
        "message": (
            (
                "Đã kết nối Google Flow bằng bản sao riêng của profile Chrome bạn đã chọn."
                if _profile_selection.get("mode") == "chrome"
                else "Đã kết nối Google Flow bằng profile riêng của StoryFlow."
            )
            if connected
            else "Flow Worker sẵn sàng. Bấm Kết nối Flow để chọn profile/đăng nhập."
        ),
    }


def open_for_login(project_url=None, profile_mode=None, profile_directory=None):
    requested_mode = profile_mode if profile_mode in ("storyflow", "chrome") else _profile_selection.get("mode", "storyflow")
    requested_directory = profile_directory or _profile_selection.get("profileDirectory", "Default")

    changed = (
        requested_mode != _profile_selection.get("mode")
        or requested_directory != _profile_selection.get("profileDirectory")
    )
    if changed:
        close_driver()
        save_profile_selection(requested_mode, requested_directory)

    driver = ensure_driver(visible=True, target_url=project_url or PROJECT_URL)
    try:
        driver.maximize_window()
    except Exception:
        pass
    return connected_health()

def generate_image(prompt, aspect="16:9", project_url=None):
    prompt = (prompt or "").strip()
    if not prompt:
        raise ValueError("Prompt Flow đang trống.")

    with _state_lock:
        _state["queued"] += 1

    _generate_lock.acquire()
    try:
        with _state_lock:
            _state["queued"] = max(0, _state["queued"] - 1)
            _state["active"] = True
            _state["lastPrompt"] = prompt[:160]
            _state["lastError"] = ""

        driver = ensure_driver(visible=False, target_url=project_url or PROJECT_URL)
        if "accounts.google.com" in (driver.current_url or ""):
            raise RuntimeError(
                "Flow chưa đăng nhập. Bấm Kết nối Flow và đăng nhập thủ công một lần."
            )
        if not flow_host(driver.current_url):
            raise RuntimeError("Cửa sổ StoryFlow chưa ở Google Flow.")

        before = large_image_sources(driver)
        submit_prompt(driver, prompt, aspect)
        result = wait_new_image(driver, before)
        src = result.get("src")
        if not src:
            raise RuntimeError("Không đọc được nguồn ảnh mới nhất từ Flow.")
        data = fetch_image(driver, src)
        if len(data) < 10_000:
            raise RuntimeError("Ảnh Flow trả về không hợp lệ.")

        with _state_lock:
            _state["lastCompletedAt"] = now_iso()
        if COOLDOWN_SECONDS > 0:
            time.sleep(COOLDOWN_SECONDS)
        return data
    except Exception as exc:
        try:
            if _driver is not None:
                diagnostic(_driver, "generate-error")
        except Exception:
            pass
        with _state_lock:
            _state["lastError"] = str(exc)
        raise
    finally:
        with _state_lock:
            _state["active"] = False
        _generate_lock.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "StoryFlowFlow/1.0"

    def log_message(self, format, *args):
        print("[flow]", format % args, flush=True)

    def send_json(self, status, body):
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8") or "{}")

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, connected_health())
            return
        if self.path == "/profiles":
            self.send_json(200, {
                "profiles": chrome_profiles(),
                "selection": _profile_selection,
                "chromeUserDataDir": str(CHROME_USER_DATA_DIR),
            })
            return
        self.send_json(404, {"error": "Không tìm thấy Flow Worker endpoint."})

    def do_POST(self):
        try:
            payload = self.read_json()
            if self.path == "/open":
                self.send_json(
                    200,
                    open_for_login(
                        str(payload.get("projectUrl") or PROJECT_URL),
                        str(payload.get("profileMode") or ""),
                        str(payload.get("profileDirectory") or ""),
                    ),
                )
                return
            if self.path == "/close":
                close_driver()
                self.send_json(200, connected_health())
                return
            if self.path == "/generate":
                data = generate_image(
                    str(payload.get("prompt") or ""),
                    str(payload.get("aspect") or "16:9"),
                    str(payload.get("projectUrl") or PROJECT_URL),
                )
                self.send_response(200)
                self.send_header("Content-Type", mime_for(data))
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-StoryFlow-Model", MODEL_LABEL)
                self.end_headers()
                self.wfile.write(data)
                return
            self.send_json(404, {"error": "Không tìm thấy Flow Worker endpoint."})
        except Exception as exc:
            traceback.print_exc()
            self.send_json(500, {"error": str(exc)})


def main():
    print(f"StoryFlow Selenium Flow Worker: http://{HOST}:{PORT}", flush=True)
    print(
        "StoryFlow dùng profile Chrome riêng hoặc bản sao cục bộ của profile đã chọn; "
        "không khóa Chrome đang mở và không đọc mật khẩu/token.",
        flush=True,
    )
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        close_driver()


if __name__ == "__main__":
    main()
