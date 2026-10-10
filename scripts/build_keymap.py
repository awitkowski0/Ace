import json, os, sys, glob
import xml.etree.ElementTree as ET

K = sys.argv[1]          # extracted keymap XML dir
DESC = sys.argv[2]       # extracted descriptor XML dir
CUSTOM = sys.argv[3]     # user keymap XML
OUT = sys.argv[4]
LIST_FILE = sys.argv[5]  # shortcut-xmls.txt (ordering of descriptor files)

SWAP = {"control": "meta", "ctrl": "meta", "meta": "control"}
def norm(stroke):  # canonical spelling used for equality checks
    return " ".join("control" if t == "ctrl" else t for t in stroke.split(" "))
def convert_stroke(stroke):  # MacOSDefaultKeymap.mapModifiers: swap ctrl<->meta
    return " ".join(SWAP.get(t, t) for t in stroke.split(" "))
def convert_shortcut(s):
    first, sep, second = s.partition(", ")
    return convert_stroke(first) + (", " + convert_stroke(second) if sep else "")
def kb_string(first, second):
    return f"{first}, {second}" if second else first

# ---- 1. keymap XML: own entries per keymap (action -> list; [] = cleared) ----
def load_keymap(path):
    own = {}
    for act in ET.parse(path).getroot().findall("action"):
        own[act.get("id")] = [norm(kb_string(k.get("first-keystroke"), k.get("second-keystroke")))
                              for k in act.findall("keyboard-shortcut") if k.get("first-keystroke")]
    return own

# ---- 2. descriptor XML: ops per keymap, in file order ----
ops = {}  # keymap -> list of (action_id, kind, stroke)
desc_files = []
for line in open(LIST_FILE):
    line = line.strip()
    if not line:
        continue
    jar, _, entry = line.partition("!")
    fname = os.path.join(DESC, jar.replace("/", "_") + entry.lstrip("/").replace("/", "_"))
    desc_files.append(fname)
n_desc_actions = 0
for fname in desc_files:
    try:
        root = ET.parse(fname).getroot()
    except Exception as e:
        print("skip (parse error):", os.path.basename(fname), e, file=sys.stderr)
        continue
    # Module descriptors are embedded as CDATA text (<module><![CDATA[<idea-plugin>...]]></module>);
    # ElementTree exposes them as text, so parse those payloads as XML too.
    roots = [root]
    for el in root.iter():
        for txt in (el.text, ):
            if txt and "<action" in txt:
                try:
                    roots.append(ET.fromstring(txt.strip()))
                except ET.ParseError as e:
                    print("skip cdata:", os.path.basename(fname), e, file=sys.stderr)
    for r_ in roots:
      for act in r_.iter("action"):
        aid = act.get("id")
        if not aid:
            continue
        found = False
        for ks in act.findall("keyboard-shortcut"):
            keymap = ks.get("keymap")
            first = ks.get("first-keystroke")
            if not keymap or not first:
                continue
            found = True
            s = norm(kb_string(first, ks.get("second-keystroke")))
            remove = (ks.get("remove") or "").lower() == "true"
            replace = (ks.get("replace-all") or "").lower() == "true"
            lst = ops.setdefault(keymap, [])
            # same order as ActionPluginRegistrar.processRemoveAndReplace
            if remove:
                lst.append((aid, "remove", s))
            if replace:
                lst.append((aid, "clear", None))
            if not remove:
                lst.append((aid, "add", s))
        n_desc_actions += found

# ---- 3. KeymapImpl engine emulation ----
class Layer:
    def __init__(self, name, own, parent=None, convert=False):
        self.name, self.own, self.parent, self.convert = name, own, parent, convert
        self.ops = ops.get(name, [])
    def inherited(self, aid):
        if self.parent is None:
            return []
        eff = self.parent.effective(aid)
        return [convert_shortcut(s) for s in eff] if self.convert else list(eff)
    def effective(self, aid):
        if aid in self.own:
            return self.own[aid]
        return self.inherited(aid)
    def apply_ops(self):
        for aid, kind, s in self.ops:
            if kind == "remove":
                base = self.effective(aid)
                if s in base:
                    self.own[aid] = [x for x in base if x != s]
            elif kind == "clear":
                if self.effective(aid):
                    self.own[aid] = []
            elif kind == "add":
                base = self.effective(aid)
                if not base:
                    self.own[aid] = [s]
                elif s not in base:
                    self.own[aid] = base + [s]

# Build layers: $default is the root; Mac layers inherit it with the ctrl<->meta conversion
dflt_own = load_keymap(os.path.join(K, "default.xml"))
mac_own = load_keymap(os.path.join(K, "macosx.xml"))
mac105_own = load_keymap(os.path.join(K, "macosx105.xml"))
user_own = load_keymap(CUSTOM)

d = Layer("$default", dflt_own)
mo = Layer("Mac OS X", mac_own, parent=d, convert=True)
m105 = Layer("Mac OS X 10.5+", mac105_own, parent=mo)
u = Layer("macOS copy", user_own, parent=m105)
for layer in (d, mo, m105, u):
    layer.apply_ops()

# Actions referenced anywhere (for final resolution)
all_ids = set(dflt_own) | set(mac_own) | set(mac105_own) | set(user_own)
for lst in ops.values():
    all_ids |= {aid for aid, _, _ in lst}

resolved = {}
for aid in all_ids:
    eff = u.effective(aid)
    if eff:
        resolved[aid] = eff

# Synthetic entries not declared anywhere in XML
SYNTHETIC = {"SearchEverywhere": ["shift shift"]}
synthetic_used = []
for aid, strokes in SYNTHETIC.items():
    if aid not in resolved:
        resolved[aid] = strokes
        synthetic_used.append(aid)

out = {k: resolved[k] for k in sorted(resolved)}
meta = {
    "source": ("IntelliJ IDEA 2025.1 app.jar keymaps/ ($default.xml, Mac OS X.xml, Mac OS X 10.5+.xml) "
               "+ descriptor XML <keyboard-shortcut> entries in 48 jar resources (PlatformActions.xml etc.) "
               "+ user's macOS copy.xml"),
    "parents": ["$default", "Mac OS X", "Mac OS X 10.5+", "macOS copy (user custom)"],
    "conversion": ("Shortcuts inherited from $default by Mac OS X are converted per MacOSDefaultKeymap.mapModifiers "
                   "(swap control<->meta, incl. descriptor keymap=\"$default\" ops); Mac and user layers literal"),
    "engine": ("keymap XML loaded first, then descriptor ops applied per keymap in file order "
               "(remove / replace-all / add, as KeymapImpl.doInitShortcuts)"),
    "synthetic": sorted(synthetic_used),
    "layers": ["$default", "Mac OS X", "Mac OS X 10.5+", "macOS copy"],
    "actionCount": len(out),
}
result = {"$meta": meta}
result.update(out)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    json.dump(result, f, indent=2, ensure_ascii=False)
    f.write("\n")
print("descriptor files:", len(desc_files), "actions with keymap shortcuts:", n_desc_actions)
print("keyboard shortcuts resolved for actions:", len(out))
