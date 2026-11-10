import Cocoa

// A native entry point lets Finder launch the project without opening Terminal.
let project = Bundle.main.bundleURL.deletingLastPathComponent()
let runner = Process()
runner.executableURL = URL(fileURLWithPath: "/bin/zsh")
runner.arguments = [project.appendingPathComponent("scripts/launch-mac.sh").path]
runner.currentDirectoryURL = project
do {
    try runner.run()
    runner.waitUntilExit()
    exit(runner.terminationStatus)
} catch {
    let alert = NSAlert()
    alert.messageText = "Auto Work 启动失败"
    alert.informativeText = error.localizedDescription
    alert.runModal()
    exit(1)
}
