// Scratch Godot project for scripts/qa/godot.mjs (project.godot, a few scenes/scripts, a README with a Dev tools block).
import fs from "node:fs";
import path from "node:path";

export function makeProject(dir, { port = 47311 } = {}) {
  const W = (rel, text) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  W("project.godot", `; Engine configuration file.\nconfig_version=5\n\n[application]\n\nconfig/name="Scratch Game"\nrun/main_scene="res://scenes/main.tscn"\nconfig/features=PackedStringArray("4.7")\n`);
  W("scenes/main.tscn", `[gd_scene load_steps=3 format=3]\n\n[ext_resource type="Script" path="res://scripts/main.gd" id="1_a"]\n[ext_resource type="PackedScene" path="res://scenes/other.tscn" id="2_b"]\n\n[node name="Main" type="Node2D"]\nscript = ExtResource("1_a")\n\n[node name="Other" parent="." instance=ExtResource("2_b")]\n\n[node name="Group" type="Node" parent="." groups=["g"]]\n\n[node name="Leaf" type="Sprite2D" parent="Group"]\n`);
  W("scenes/other.tscn", `[gd_scene format=3]\n\n[node name="Other" type="Node"]\n`);
  W("scenes/loop.tscn", `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://scripts/loop_scene.gd" id="1_a"]\n\n[node name="Loop" type="Node"]\nscript = ExtResource("1_a")\n`);
  W("scenes/boom.tscn", `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://scripts/boom.gd" id="1_a"]\n\n[node name="Boom" type="Node"]\nscript = ExtResource("1_a")\n`);
  // line numbers matter for the debugger checks: `var y := compute(x)` is line 9, `var z := v + 1` is line 15
  W("scripts/main.gd", `extends Node2D\n\nvar counter := 0\nvar label_text := "hello"\n\nfunc _ready() -> void:\n\tprint("MAIN READY")\n\tvar x := 41\n\tvar y := compute(x)\n\tprint("result ", y)\n\tget_tree().quit()\n\nfunc compute(v: int) -> int:\n\tcounter += 1\n\tvar z := v + 1\n\treturn z\n`);
  W("scripts/loop_scene.gd", `extends Node\n\nfunc value() -> int:\n\treturn 1\n\nvar acc := 0.0\n\nfunc _process(delta: float) -> void:\n\tacc += delta\n\tif acc > 0.4:\n\t\tacc = 0.0\n\t\tprint("VALUE ", value())\n`);
  W("scripts/boom.gd", `extends Node\n\nfunc _ready() -> void:\n\tprint("BOOM START")\n\tvar d := {"a": 1}\n\tvar n: Node = null\n\tprint(n.name)\n\tprint("BOOM AFTER")\n\tget_tree().quit()\n`);
  W("tools/sim/hello.gd", `extends SceneTree\n## Prints its arguments\n\nfunc _init() -> void:\n\tprint("HELLO ", OS.get_cmdline_user_args())\n\tprintraw("")\n\tquit(0)\n`);
  W("tools/sim/err.gd", `extends SceneTree\n\nfunc _init() -> void:\n\tprint("ERR START")\n\tpush_warning("careful now")\n\tvar n: Node = null\n\tboom(n)\n\tprint("ERR END")\n\nfunc boom(n) -> void:\n\tprint(n.name)\n`);
  W("tools/sim/parse_err.gd", `extends SceneTree\n\nfunc _init() -> void:\n\tvar x: int = "str"\n\tprint(undefined_thing)\n\tquit()\n`);
  W("tools/sim/dbg_script.gd", `extends SceneTree\n\nfunc _init() -> void:\n\tvar a := 5\n\tvar b := a * 2\n\tprint("DBG SCRIPT ", b)\n\tquit(0)\n`);
  W("tools/sim/net_test.gd", `extends SceneTree
var role := ""
var port := 0
var server: TCPServer
var peer: StreamPeerTCP
var t := 0.0
var sent := false
var retry := 0.0

func _initialize() -> void:
	var a := OS.get_cmdline_user_args()
	role = a[0]
	port = int(a[1])
	if role == "host":
		server = TCPServer.new()
		print("HOST listening ", server.listen(port, "127.0.0.1"))
	else:
		print("CLIENT connecting")
		_connect()

func _connect() -> void:
	peer = StreamPeerTCP.new()
	peer.connect_to_host("127.0.0.1", port)

func _process(delta: float) -> bool:
	t += delta
	if role == "host":
		if peer == null and server.is_connection_available():
			peer = server.take_connection()
			print("HOST got client")
		if peer != null:
			peer.poll()
			if peer.get_available_bytes() > 0:
				var s := peer.get_utf8_string(peer.get_available_bytes())
				print("HOST received ", s)
				peer.put_data("pong".to_utf8_buffer())
				peer.poll()
				return true
	else:
		peer.poll()
		var st := peer.get_status()
		if st == StreamPeerTCP.STATUS_ERROR or st == StreamPeerTCP.STATUS_NONE:
			retry += delta
			if retry > 0.5:
				retry = 0.0
				_connect()
		elif st == StreamPeerTCP.STATUS_CONNECTED and not sent:
			peer.put_data("ping".to_utf8_buffer())
			sent = true
			print("CLIENT sent ping")
		if sent and peer.get_available_bytes() > 0:
			print("CLIENT received ", peer.get_utf8_string(peer.get_available_bytes()))
			return true
	if t > 25.0:
		print("TIMEOUT ", role)
		return true
	return false
`);
  W("scripts/characters/tools/check.gd", `extends SceneTree\n\nfunc _init() -> void:\n\tquit(0)\n`);
  W("scripts/ui/helper.gd", `extends Node\n`);
  W("addons/x/tools/skip.gd", `extends SceneTree\n`);
  W("tools/plain.gd", `extends Node\n`);
  W("README.md", `# Scratch\n\n### Dev tools\n\`\`\`
tools/run_godot.sh 60 --headless --script res://tools/sim/hello.gd -- a b        # hello sim
tools/run_godot.sh 3 --headless --script res://tools/sim/err.gd                  # error sim (never exits)
tools/run_godot.sh 30 --headless --script res://tools/sim/parse_err.gd           # parse error
tools/run_godot.sh 40 --headless --script res://tools/sim/net_test.gd -- host|client ${port}     # LAN test (two processes)
tools/run_godot.sh 20 --headless res://scenes/loop.tscn                           # loop scene
python3 tools/audio/generate_all.py                                              # regenerate audio
\`\`\`
`);
  return dir;
}
