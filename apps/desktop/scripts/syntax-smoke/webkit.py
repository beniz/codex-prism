"""Run Vite on :1438, then this real WebKitGTK smoke test. Screenshot goes to /tmp."""
import gi, json, time, sys
gi.require_version('Gtk', '3.0')
gi.require_version('WebKit2', '4.1')
from gi.repository import Gtk, WebKit2, GLib
window = Gtk.Window()
window.set_default_size(1440, 1200)
view = WebKit2.WebView()
view.get_settings().set_enable_write_console_messages_to_stdout(True)
window.add(view)
window.show_all()
started = busy = passed = False
deadline = time.time() + 60

def evaluate(script, callback):
    def done(view, result, _):
        global busy
        try:
            callback(json.loads(view.evaluate_javascript_finish(result).to_json(0)))
        except Exception as error:
            print('ERROR', error, flush=True)
            Gtk.main_quit()
        busy = False
    view.evaluate_javascript(script, -1, None, None, None, done, None)

def screenshot(view, result, _):
    try:
        view.get_snapshot_finish(result).write_to_png('/tmp/codex-prism-syntax.png')
        print('Screenshot: /tmp/codex-prism-syntax.png', flush=True)
    finally:
        Gtk.main_quit()

def tick():
    global busy
    if time.time() > deadline:
        print('TIMEOUT', flush=True)
        Gtk.main_quit()
        return False
    if busy:
        return True
    busy = True
    if not started:
        def ready(value):
            global started
            if value:
                started = True
                evaluate('window.runSmoke().then(r=>window.smokeResult=r).catch(e=>window.smokeResult={error:String(e)});true', lambda _: None)
        evaluate('Boolean(window.runSmoke)', ready)
    else:
        def result(value):
            global passed, busy
            if value:
                print(json.dumps(value), flush=True)
                passed = bool(value.get('ok'))
                if passed:
                    view.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, screenshot, None)
                else:
                    Gtk.main_quit()
        evaluate('window.smokeResult||null', result)
    return True

view.load_uri('http://127.0.0.1:1438/scripts/syntax-smoke/index.html')
GLib.timeout_add(250, tick)
Gtk.main()
sys.exit(0 if passed else 1)
