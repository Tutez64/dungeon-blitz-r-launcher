import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1]) ?? 0
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
var found = 0
for window in list {
    let owner = window[kCGWindowOwnerPID as String] as? Int32 ?? -1
    let ownerName = window[kCGWindowOwnerName as String] as? String ?? "?"
    if owner == pid || ownerName.contains("Flash") {
        let name = window[kCGWindowName as String] as? String ?? "<no name: needs screen recording permission>"
        let layer = window[kCGWindowLayer as String] as? Int ?? -1
        print("owner=\(ownerName) pid=\(owner) layer=\(layer) title=\(name)")
        found += 1
    }
}
if found == 0 { print("no windows for pid \(pid)") }
