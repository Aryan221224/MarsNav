# Screenshots for the user guide (MarsNav_User_Guide.pdf), taken from the running desktop app.
#
#   MarsNav.exe --debug-port 9335          (DevTools on localhost only, for this script)
#   python tools/gcap.py tools/guide/capture_guide.py [part ...]
#
# Parts: plan 3d exec tour drive sites landing overlays local (default: all, in that order). Pictures go to data_cache/guide/:
# win() is the whole window (title bar and menu included), shot() the page or one element of it.
import math
import sys

PARTS = [a for a in sys.argv[2:]] or ["plan", "3d", "exec", "tour", "drive", "sites", "landing", "overlays", "local"]


def setval(sel, v):
    return js(f"(()=>{{const e=document.querySelector({sel!r}); e.value={json.dumps(str(v))}; e.dispatchEvent(new Event('input',{{bubbles:true}})); e.dispatchEvent(new Event('change',{{bubbles:true}})); return e.value}})()")


def planner(hash_=""):
    go("/index.html" + hash_, settle=3)
    js("try{localStorage.setItem('mm.layersOpen','0')}catch(e){}; location.reload(); 1")
    _ws.clear()
    wait(5)
    until("document.getElementById('busy').hidden && document.querySelector('#cards').innerText.includes('BALANCED')", 120)
    wait(1.5)


def layer(v):
    js(f"(()=>{{const i=[...document.querySelectorAll('#layers input[type=radio]')].find(x=>x.value=='{v}'); i.click(); return 1}})()")
    wait(2.5)


def scroll_to(panel, sel, off=8):
    js(f"(()=>{{const e=document.querySelector({sel!r}); const P=document.getElementById({panel!r}); P.scrollTop=e.offsetTop-{off}; return P.scrollTop}})()")
    wait(0.7)


def plan_and_wait(t=90):
    click("#btnPlan")
    wait(1.5)
    until("document.getElementById('busy').hidden", t)
    wait(1.5)


# ------------------------------------------------------------------------------------------------ EVA planner: Plan
if "plan" in PARTS:
    planner()
    click("#zoomFit"); wait(2)
    win("p01_plan_overview")
    for v, n in (("sand", "p02_layer_sand"), ("walkback", "p03_layer_walkback"), ("slope", "p04_layer_slope"),
                 ("shade", "p05_layer_shade"), ("los", "p06_layer_los")):
        layer(v)
        win(n)
    layer("hazard")
    js("document.getElementById('left').scrollTop=0"); wait(0.4)
    shot("p07_setup_panel", "#left")
    js("document.getElementById('hwBox').open=true; 1"); wait(0.5)
    scroll_to("left", "#hwBox"); shot("p08_checkout_panel", "#left")
    js("document.getElementById('hwBox').open=false; 1")
    scroll_to("left", "#stations", 40); shot("p09_stations", "#left")
    click("#btnOptimise"); wait(3)
    scroll_to("left", "#btnOptimise", 120); shot("p10_sortie", "#left")
    scroll_to("left", "#ahpBox", 40); shot("p11_ahp", "#left")
    js("document.getElementById('right').scrollTop=0"); wait(0.3)
    shot("p12_cards", "#right")
    scroll_to("right", "#why", 40); shot("p13_why_guidance", "#right")
    js("document.getElementById('right').scrollTop=0")
    shot("p14_timeline", "#tl")
    # point of no return: an EVA too short for the stations
    setval("#evaMax", "1.5"); plan_and_wait()
    win("p15_no_return")
    js("document.getElementById('left').scrollTop = document.getElementById('btnPlan').offsetTop - 300"); wait(0.6)
    shot("p16_no_return_msg", "#left")
    setval("#evaMax", "7"); plan_and_wait()
    # landing site and hub at site scale
    setval("#landerSel", "human")
    scroll_to("left", "#landingSec")
    click("#btnLandBest"); wait(2)
    until("!/running|searching|…/i.test(document.getElementById('landOut').innerText)", 60)
    wait(1)
    layer("landing"); wait(1)
    scroll_to("left", "#landingSec")
    win("p20_landing_hub")
    shot("p21_landing_panel", "#left")
    layer("hazard")
    js("document.getElementById('left').scrollTop=0")

# ------------------------------------------------------------------------------------------------ 3D view (fresh page)
if "3d" in PARTS:
    planner()
    click("#btn3d"); wait(7)
    c = js("(()=>{const r=document.getElementById('view3d').getBoundingClientRect(); return [r.x+r.width/2, r.y+r.height/2]})()")
    for _ in range(4):
        _call("MarsNav", "Input.dispatchMouseEvent", {"type": "mouseWheel", "x": c[0], "y": c[1], "deltaX": 0, "deltaY": -240})
        wait(0.25)
    wait(2)
    win("p17_3d_orbit")
    js("(()=>{const b=document.querySelector('[data-v3=helmet]'); b && b.click(); return 1})()"); wait(5)
    win("p18_3d_helmet")
    click("#v3play"); wait(7)
    win("p19_3d_walk")
    click("#v3close"); wait(2)

# ------------------------------------------------------------------------------------------------ Execute and Review
if "exec" in PARTS:
    planner()
    click("#tabExec"); wait(1.5)
    setval("#telSrc", "sim"); setval("#truthSel", "hardwork"); setval("#simSpeed", "120")
    shot("e01b_exec_left", "#left")
    click("#btnRun")
    until("!/Shown while working/.test(document.getElementById('proc').innerText) && document.getElementById('proc').innerText.trim().length > 40", 150, step=1)
    wait(2)
    win("e05_station")
    scroll_to("right", "#loopBox", 40); shot("e03b_loop_panel", "#right")
    js("(()=>{const b=document.querySelector('[data-ask=o2]'); b && b.click(); return 1})()"); wait(1.5)
    scroll_to("right", "#proc", 40); shot("e05b_proc_voice", "#right")
    js("document.getElementById('right').scrollTop=0")
    wait(10)
    js("(()=>{const b=document.querySelector('[data-fault=leak]'); b && b.click(); return 1})()"); wait(1.8)
    win("e06_leak_return")
    wait(90)                                 # the contingency return home, at 120x
    click("#btnPause"); wait(1)
    click("#tabReview"); wait(3)
    win("r01_review")
    shot("r02_review_right", "#right")
    scroll_to("right", "#aar", 40); shot("r02b_aar", "#right")
    scroll_to("right", "#prov", 40); shot("r02c_prov", "#right")
    js("document.getElementById('right').scrollTop=0")
    click("#btnCue"); wait(2.5)
    win("r04_cue_card")
    click("#modalClose"); wait(1)
    click("#tabPlan"); wait(1)

# ------------------------------------------------------------------------------------------------ guided tour
if "tour" in PARTS:
    planner()
    click("#btnTour"); wait(3)
    win("t01_tour_1")
    for k in range(2, 8):
        click("#tourNext"); wait(4.5)
        print(f"tour {k}:", js("document.getElementById('tourTitle').innerText"))
        win(f"t0{k}_tour")
    click("#tourEnd"); wait(2)
    js("try{localStorage.setItem('mm.layersOpen','0')}catch(e){}; 1")

# ------------------------------------------------------------------------------------------------ drive window
if "drive" in PARTS:
    planner()
    click("#tabExec"); wait(1.5)
    setval("#telSrc", "drive"); wait(1)
    click("#btnDrive"); wait(12)
    title = [t.get("title") for t in json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json").read()) if t["type"] == "page" and "Drive" in (t.get("title") or "")]
    win("d01_drive", title="MarsNav · Drive")          # the native window keeps the title it was opened with
    setval("#telSrc", "sim"); click("#tabPlan"); wait(1)

# ------------------------------------------------------------------------------------------------ other sites
if "sites" in PARTS:
    planner("#jezero_east"); win("w_s01_jezero_east")
    go("/index.html#g_3p144n_155p311e", settle=3)
    js("location.reload(); 1"); _ws.clear(); wait(6)
    until("document.getElementById('busy').hidden", 120)
    wait(3); win("w_s02_built_hub")
    go("/index.html", settle=3)


# ------------------------------------------------------------------------------------------------ Landing mode
def ovl(name, on):
    js(f"(()=>{{const i=document.querySelector('input[data-ovl={name}]'); if(i.checked!=={str(on).lower()}) i.click(); return i.checked}})()")


def all_ovl_off():
    for o in ("safety", "ice", "geology", "craters", "ti", "grs"):
        ovl(o, False)


def rng():
    h = js("decodeURIComponent(location.hash.slice(1))") or ""
    try:
        return float(h.split(",")[2])
    except Exception:  # noqa: BLE001
        return None


def zoom_to(target):
    for _ in range(30):
        r = rng()
        if r is None:
            wait(0.5)
            continue
        if r < target / 1.35:
            click("#zOut")
        elif r > target * 1.35:
            click("#zIn")
        else:
            return r
        wait(0.6)
    return rng()


def scroll_dossier(f):
    return js(f"""(()=>{{const root=document.getElementById('dossier');
      const sc=[root,...root.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+20 && getComputedStyle(e).overflowY!='visible');
      if(!sc) return 'none'; sc.scrollTop = {f}*(sc.scrollHeight-sc.clientHeight); return [sc.scrollTop, sc.scrollHeight]}})()""")


def legend():
    return js("[...document.querySelectorAll('#legend .lg b')].map(b=>b.innerText).join(' + ')")


if "landing" in PARTS:
    go("/landing.html#20.0000,20.0000,11000.00,0,0,best,hls2,,", settle=3)
    js("location.reload(); 1"); _ws.clear(); wait(12)
    all_ovl_off()
    win("l01_overview")
    name = "Arcadia Planitia AP-1"
    print("cand:", js(f"""(()=>{{const li=[...document.querySelectorAll('#candList li')].find(l=>l.innerText.includes({json.dumps(name)})); if(!li) return 'none'; li.click(); return li.innerText.slice(0,60)}})()"""))
    wait(8)
    win("l02_candidate")
    click("#btnAssess"); wait(3)
    until("document.getElementById('dProgress').hidden && !/Preliminary|Not assessed/.test(document.getElementById('dVerdict').innerText)", 300, step=1)
    print("verdict:", js("document.getElementById('dVerdict').innerText + ' / ' + document.getElementById('dScore').innerText"))
    wait(15)
    win("l03a_assessed_close")
    for i, f in enumerate([0, 0.2, 0.4, 0.6, 0.8, 1.0]):
        scroll_dossier(f); wait(0.5)
        shot(f"l04_dossier_{i}", "#dossier")
    scroll_dossier(0)
    print("range:", zoom_to(30)); wait(14)
    ovl("safety", True); wait(14); win("l05_safety"); ovl("safety", False); wait(2)
    click("#btnReport"); wait(6)
    pages = [t.get("title") for t in json.loads(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json").read()) if t["type"] == "page"]
    rep = [t for t in pages if t and "dossier" in t.lower()]
    if rep:
        shot("l11_report", page=rep[-1])
    click("#btnHub"); wait(2); shot("l08b_hubcard", "#dossier"); click("#btnSiteCancel"); wait(1)
    for tab in ("hubs", "data"):
        js(f"document.querySelector('[data-tab={tab}]').click(); 1"); wait(1.5)
        shot(f"l09_tab_{tab}", ".rail.left")
    js("document.querySelector('[data-tab=cand]').click(); 1"); wait(1)

if "overlays" in PARTS:
    h = js("decodeURIComponent(location.hash.slice(1))") or ""
    sel = h.split(",")[8] if len(h.split(",")) > 8 else ""
    go(f"/landing.html#39.8000,-157.9000,1928.00,0,0,best,hls2,,{sel}", settle=3)
    js("location.reload(); 1"); _ws.clear(); wait(16)
    all_ovl_off(); wait(2)
    for names, key, out in ((("geology", "craters"), "GEOLOGIC", "c_l07_geology_craters"), (("ti",), "THERMAL", "c_l07b_thermal"),
                            (("ice",), "WATER ICE", "c_l06_ice"), (("grs",), "WATER", "c_l06c_grs")):
        for n in names:
            ovl(n, True)
        until(f"/{key}/i.test([...document.querySelectorAll('#legend .lg b')].map(b=>b.innerText).join(' '))", 60)
        wait(13)
        print("legend:", legend())
        shot(out)
        for n in names:
            ovl(n, False)
        wait(2)
    for base, out in (("themis_night", "c_l06d_themis_night"), ("mola", "c_l06e_mola")):
        js(f"(()=>{{const s=document.getElementById('baseSel'); s.value='{base}'; s.dispatchEvent(new Event('change')); return s.value}})()")
        wait(15)
        shot(out)
    js("(()=>{const s=document.getElementById('baseSel'); s.value='best'; s.dispatchEvent(new Event('change')); return s.value})()")
    wait(3)

if "local" in PARTS:
    go("/landing.html#20.0000,20.0000,11000.00,0,0,best,hls2,,", settle=3)
    js("location.reload(); 1"); _ws.clear(); wait(10)
    click("#localPill"); wait(3)
    want = {"elevation": True, "blend": True, "viking": True, "mola_shade": True, "geology": True, "science": True,
            "reference": True, "themis_day": False, "themis_night": False}
    for k, v in want.items():
        js(f"(()=>{{const c=document.querySelector('#globalTbl [data-gp={k}]'); if(c && c.checked!=={str(v).lower()}) c.click(); return c && c.checked}})()")
    wait(1)
    click("#btnEstimate")
    until("/Fits|does not fit|not fit/i.test(document.getElementById('localEst').innerText)", 300, step=2)
    wait(2)
    js("(()=>{const sc=document.querySelector('#localModal .mbox'); if(sc) sc.scrollTop=0; return 1})()"); wait(1)
    win("l13_local_estimate")
    js("(()=>{const c=document.getElementById('marsChk'); if(!c.checked) c.click(); return c.checked})()"); wait(3)
    click("#localClose"); wait(7)
    win("l15_mars_mode")
    click("#localPill"); wait(2)
    js("(()=>{const c=document.getElementById('marsChk'); if(c.checked) c.click(); return c.checked})()"); wait(3)
    click("#localClose"); wait(2)
    print("mode now:", js("document.getElementById('localPill').innerText + ' | ' + document.body.className"))
