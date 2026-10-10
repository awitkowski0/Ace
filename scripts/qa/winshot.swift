import Cocoa
import CoreGraphics

// winshot <pid>: print the CGWindowID of the largest normal-layer window owned by pid (works for unfocused or
// occluded windows; activates nothing). shot.sh passes the id to `screencapture -l`.
let a = CommandLine.arguments
guard a.count == 2, let pid = Int32(a[1]) else { FileHandle.standardError.write("usage: winshot pid\n".data(using: .utf8)!); exit(2) }
let list = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
var best: (id: UInt32, area: CGFloat)? = nil
for w in list {
    guard (w[kCGWindowOwnerPID as String] as? Int32) == pid, (w[kCGWindowLayer as String] as? Int) == 0,
          let b = w[kCGWindowBounds as String] as? [String: CGFloat], let id = w[kCGWindowNumber as String] as? UInt32 else { continue }
    let area = (b["Width"] ?? 0) * (b["Height"] ?? 0)
    if area > 10000, best == nil || area > best!.area { best = (id, area) }
}
guard let win = best else { FileHandle.standardError.write("no window for pid \(pid)\n".data(using: .utf8)!); exit(1) }
print(win.id)
