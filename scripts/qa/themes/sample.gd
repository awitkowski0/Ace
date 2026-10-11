class_name Player
extends CharacterBody3D
## Docs here
signal died(who: Node)
const MAX_HP := 100
@export var speed: float = 5.0
@onready var sprite: Sprite3D = $Sprite3D
var hp := MAX_HP

func take(damage: int, from: Node = null) -> void:
	var v := Vector3(1, 2.5, 0x1F)
	if hp <= 0 and not is_dead():
		emit_signal("died", self)
	print("hit %s" % str(damage))
	$"../Label".text = String(&"abc") + str(^"Node/Path")
	for i in range(10):
		self.hp -= i
