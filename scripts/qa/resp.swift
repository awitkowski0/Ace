import Foundation
// resp <pid>: print pid followed by every process whose *responsible* pid (launchd attribution, the same one
// Activity Monitor uses to group WebKit XPC helpers under their app) equals pid.
@_silgen_name("responsibility_get_pid_responsible_for_pid") func responsible(_ pid: pid_t) -> pid_t
guard CommandLine.arguments.count == 2, let root = Int32(CommandLine.arguments[1]) else { exit(2) }
var n = proc_listallpids(nil, 0)
var pids = [pid_t](repeating: 0, count: Int(n) + 64)
n = proc_listallpids(&pids, Int32(pids.count * MemoryLayout<pid_t>.size))
print(root)
for p in pids.prefix(Int(n)) where p > 1 && p != root && responsible(p) == root { print(p) }
