"""Run Vite on :1438 before this mocked-backend, real WebKit UI test."""
import gi,json,time,sys
gi.require_version('Gtk','3.0');gi.require_version('WebKit2','4.1')
from gi.repository import Gtk,WebKit2,GLib
window=Gtk.Window();window.set_default_size(1400,900)
view=WebKit2.WebView();view.get_settings().set_enable_write_console_messages_to_stdout(True);window.add(view);window.show_all()
deadline=time.time()+180;started=False;busy=False;passed=False
def evaluate(script, callback):
 def done(view,result,_):
  global busy
  try: callback(json.loads(view.evaluate_javascript_finish(result).to_json(0)))
  except Exception as e: print('ERROR',e,flush=True);Gtk.main_quit()
  busy=False
 view.evaluate_javascript(script,-1,None,None,None,done,None)
def tick():
 global started,busy
 if busy:return True
 busy=True
 if time.time()>deadline:
  evaluate('document.body.innerText',lambda v:print('TIMEOUT',v,flush=True));GLib.timeout_add(1000,lambda:Gtk.main_quit());return False
 if not started:
  def ready(v):
   global started
   if v: started=True;evaluate('window.runSmoke().then(r=>window.smokeResult=r).catch(e=>window.smokeResult={error:String(e),body:document.body.innerText});true',lambda v:None)
  evaluate('Boolean(window.runSmoke)',ready)
 else:
  def result(v):
   global passed
   if v:
    print(json.dumps(v),flush=True);passed=bool(v.get('ok'));Gtk.main_quit()
  evaluate('window.smokeResult||null',result)
 return True
view.load_uri('http://127.0.0.1:1438/scripts/data-sources-smoke/index.html')
GLib.timeout_add(400,tick);Gtk.main();sys.exit(0 if passed else 1)
