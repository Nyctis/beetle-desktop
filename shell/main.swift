import AppKit
import WebKit

let environment = ProcessInfo.processInfo.environment
let beetleHome = URL(fileURLWithPath: environment["BEETLE_HOME"] ?? NSHomeDirectory() + "/.beetle")
let beetleBin = environment["BEETLE_BIN"] ?? NSHomeDirectory() + "/.local/bin/beetle"
let toolDirs = [NSHomeDirectory() + "/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
let neededAPI = 1  // the oldest `beetle serve` this page works with

func readJSON(_ name: String) -> [String: Any]? {
    guard let data = try? Data(contentsOf: beetleHome.appendingPathComponent(name)) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

func which(_ name: String) -> String? {
    toolDirs.map { "\($0)/\(name)" }.first { FileManager.default.isExecutableFile(atPath: $0) }
}

/// Runs a program to the end and returns what it printed.
@discardableResult
func run(_ path: String, _ args: [String]) -> (status: Int32, out: String) {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: path)
    process.arguments = args
    process.environment = environment.merging(["PATH": toolDirs.joined(separator: ":")]) { $1 }
    process.standardOutput = pipe
    process.standardError = pipe
    process.standardInput = FileHandle.nullDevice
    do { try process.run() } catch { return (127, "\(error)") }
    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: data, as: UTF8.self))
}

/// Finds this home's `beetle serve`, starting one if nothing answers. The owner
/// token stays on this side: the page never sees it.
final class Daemon {
    private(set) var base: URL?
    private(set) var token: String?
    private(set) var outdated = false
    private var child: Process?
    private var stale: pid_t?
    private var replaced = false
    private var spawned = Date.distantPast
    private let queue = DispatchQueue(label: "beetle.daemon")
    private let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 5
        return URLSession(configuration: config)
    }()

    /// Calls back on the main thread.
    func ready(_ done: @escaping (Bool) -> Void) {
        if base != nil { return done(true) }
        queue.async {
            let found = self.find() ?? self.start()
            let old = self.stale != nil
            DispatchQueue.main.async {
                self.base = found.map(\.url)
                self.token = found?.token
                self.outdated = old
                done(found != nil)
            }
        }
    }

    func lost() {
        base = nil
    }

    /// A daemon left running from before an update answers most calls and 404s the
    /// routes it doesn't have yet, so an old one doesn't count as found.
    private func find() -> (url: URL, token: String)? {
        stale = nil
        guard let state = readJSON("serve.json"), let port = state["port"] as? Int, let tokens = readJSON("tokens.json"),
              let owner = tokens.first(where: { ($0.value as? [String: Any])?["scope"] as? String == "owner" })?.key
        else { return nil }
        let url = URL(string: "http://127.0.0.1:\(port)")!
        var request = URLRequest(url: url.appendingPathComponent("beetle/health"))
        request.setValue("Bearer \(owner)", forHTTPHeaderField: "Authorization")
        var health: [String: Any]?
        let done = DispatchSemaphore(value: 0)
        session.dataTask(with: request) { body, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200, let body {
                health = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
            }
            done.signal()
        }.resume()
        done.wait()
        guard let health else { return nil }
        let older = (health["api"] as? Int ?? 0) < neededAPI
        let moved = (health["chain"] as? String) != (readJSON("config.json")?["chain"] as? String)  // `beetle init` since it started
        if older || moved { stale = (health["pid"] as? Int).map { pid_t($0) } }
        return stale == nil ? (url, owner) : nil
    }

    /// Two daemons on one home would both resume its jobs, so a live pid means wait,
    /// and a start that's taking long is waited on, never repeated. An old daemon is
    /// replaced once: if the installed Beetle is the old one, restarting won't help.
    private func start() -> (url: URL, token: String)? {
        guard readJSON("config.json") != nil else { return nil }  // `beetle init` comes first
        if let old = stale {
            if replaced { return nil }
            replaced = true
            kill(old, SIGTERM)  // the new one carries on its jobs from disk
            for _ in 0..<40 where kill(old, 0) == 0 { Thread.sleep(forTimeInterval: 0.5) }
        }
        if let pid = readJSON("serve.json")?["pid"] as? Int, kill(pid_t(pid), 0) == 0 {
            Thread.sleep(forTimeInterval: 5)
            return find()
        }
        if child?.isRunning != true {
            if Date().timeIntervalSince(spawned) < 30 { return nil }  // it just stopped: `serve.log` says why
            spawned = Date()
            let log = beetleHome.appendingPathComponent("serve.log")
            if !FileManager.default.fileExists(atPath: log.path) {
                FileManager.default.createFile(atPath: log.path, contents: nil)
            }
            guard let output = try? FileHandle(forWritingTo: log) else { return nil }
            output.seekToEndOfFile()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: beetleBin)
            process.arguments = ["serve"]
            process.environment = environment.merging(["PATH": toolDirs.joined(separator: ":")]) { $1 }
            process.standardOutput = output
            process.standardError = output
            process.standardInput = FileHandle.nullDevice
            do { try process.run() } catch { return nil }
            child = process
        }
        for _ in 0..<40 {
            Thread.sleep(forTimeInterval: 0.5)
            if child?.isRunning != true { return nil }
            if let found = find() { return found }
            if stale != nil { return nil }
        }
        return nil
    }
}

/// Connecting an agent gives it a token that can only act within the policy.
enum Agents {
    static let all = [("claude", "Claude Code"), ("codex", "Codex")]
    private static let tokenName = "mcp"

    private static var python: String {
        URL(fileURLWithPath: beetleBin).resolvingSymlinksInPath().deletingLastPathComponent()
            .appendingPathComponent("python").path
    }

    private static func token() -> String? {
        let tokens = readJSON("tokens.json") ?? [:]
        if let known = tokens.first(where: { ($0.value as? [String: Any])?["name"] as? String == tokenName })?.key {
            return known
        }
        let made = run(beetleBin, ["token", tokenName])
        return made.status == 0 ? made.out.trimmingCharacters(in: .whitespacesAndNewlines) : nil
    }

    static func list() -> [[String: Any]] {
        all.map { id, title in
            guard let tool = which(id) else {
                return ["id": id, "title": title, "installed": false, "connected": false]
            }
            return ["id": id, "title": title, "installed": true, "connected": run(tool, ["mcp", "get", "beetle"]).status == 0]
        }
    }

    static func connect(_ id: String) -> String? {
        guard let tool = which(id) else { return "\(id) isn't installed" }
        guard let token = token() else { return "couldn't make a token" }
        let server = ["--", python, "-m", "client.mcp_server"]
        let args = id == "claude"
            ? ["mcp", "add", "-s", "user", "beetle", "-e", "BEETLE_TOKEN=\(token)"] + server
            : ["mcp", "add", "beetle", "--env", "BEETLE_TOKEN=\(token)"] + server
        return run(tool, args).status == 0 ? nil : "\(id) refused the server"
    }

    static func disconnect(_ id: String) -> String? {
        guard let tool = which(id) else { return "\(id) isn't installed" }
        let args = id == "claude" ? ["mcp", "remove", "beetle", "-s", "user"] : ["mcp", "remove", "beetle"]
        return run(tool, args).status == 0 ? nil : "\(id) refused"
    }
}

/// Selling inference from this Mac: `mlx_lm.server` answers and `beetle host run`
/// takes the orders. A Mac can't sell training yet, so it lists inference only.
final class Host {
    private static let port = 18473
    private static let venvBin = URL(fileURLWithPath: beetleBin).resolvingSymlinksInPath().deletingLastPathComponent()
    private var backend: Process?
    private var seller: Process?

    var serving: Bool { seller?.isRunning == true }

    private static func mlxRepo(_ model: String) -> String? {
        let root = venvBin.deletingLastPathComponent().deletingLastPathComponent()
        guard let data = try? Data(contentsOf: root.appendingPathComponent("common/model_profiles.json")),
              let all = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let mlx = (all[model] as? [String: Any])?["mlx"] as? [String: Any] else { return nil }
        return mlx["repo"] as? String
    }

    private func spawn(_ path: String, _ args: [String]) -> Process? {
        let log = beetleHome.appendingPathComponent("host.log")
        if !FileManager.default.fileExists(atPath: log.path) {
            FileManager.default.createFile(atPath: log.path, contents: nil)
        }
        guard let output = try? FileHandle(forWritingTo: log) else { return nil }
        output.seekToEndOfFile()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        process.environment = environment.merging(["PATH": toolDirs.joined(separator: ":")]) { $1 }
        process.standardOutput = output
        process.standardError = output
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return nil }
        return process
    }

    private func lastLine(_ text: String) -> String {
        text.split(separator: "\n").last.map(String.init) ?? "it stopped without saying why"
    }

    func report() -> [String: Any] {
        var out: [String: Any] = ["serving": serving, "configured": readJSON("config.json")?["host"] != nil]
        guard out["configured"] as? Bool == true else { return out }
        let status = run(beetleBin, ["host", "status"])
        if let data = status.out.data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) {
            out["status"] = parsed
        }
        return out
    }

    func list(model: String, input: Double, output: Double, slots: Int) -> String? {
        guard let repo = Host.mlxRepo(model) else { return "\(model) has no MLX build" }
        let setup = run(beetleBin, ["host", "init", "--backend", "http://127.0.0.1:\(Host.port)"])
        if setup.status != 0 { return lastLine(setup.out) }
        let listed = run(beetleBin, ["host", "list", "--models", model, "--infer-only", "--serves", model,
                                     "--serve-as", "\(model)=\(repo)", "--infer-in", "\(input)", "--infer-out", "\(output)",
                                     "--slots", "\(slots)"])
        return listed.status == 0 ? nil : lastLine(listed.out)
    }

    func start() -> String? {
        if serving { return nil }
        let host = readJSON("config.json")?["host"] as? [String: Any]
        guard let model = (host?["models"] as? [String])?.first, let repo = Host.mlxRepo(model) else {
            return "Set up an offer first."
        }
        backend = spawn(Host.venvBin.appendingPathComponent("mlx_lm.server").path,
                        ["--model", repo, "--host", "127.0.0.1", "--port", "\(Host.port)"])
        guard backend != nil else { return "The model server didn't start." }
        for _ in 0..<60 {
            Thread.sleep(forTimeInterval: 0.5)
            if run("/usr/bin/curl", ["-s", "-f", "--noproxy", "*", "-m", "1", "http://127.0.0.1:\(Host.port)/v1/models"]).status == 0 { break }
        }
        let resumed = run(beetleBin, ["host", "resume"])
        if resumed.status != 0 { stop(); return lastLine(resumed.out) }
        seller = spawn(beetleBin, ["host", "run"])
        Thread.sleep(forTimeInterval: 3)
        if serving { return nil }
        stop()
        return "The seller stopped. See ~/.beetle/host.log."
    }

    /// Paused first, so nobody opens a session with a machine that's going away.
    func stop() {
        if serving { run(beetleBin, ["host", "pause"]) }
        seller?.terminate()
        backend?.terminate()
        seller = nil
        backend = nil
    }
}

/// Everything the page reaches goes through beetle://app/: its own files, the
/// daemon under /api/, and this shell under /native/. Nothing else is reachable.
final class Bridge: NSObject, WKURLSchemeHandler, URLSessionDataDelegate {
    static let source = environment["BEETLE_WEB"]  // `make dev`: pages from the checkout

    var onTray: (([String]) -> Void)?
    let host = Host()
    private let root = (source.map { URL(fileURLWithPath: $0) }
        ?? Bundle.main.resourceURL!.appendingPathComponent("web")).standardizedFileURL
    private let types = ["html": "text/html", "css": "text/css", "js": "text/javascript", "woff2": "font/woff2"]
    private let daemon = Daemon()
    private var live = Set<ObjectIdentifier>()
    private var pending: [Int: WKURLSchemeTask] = [:]
    private var upstream: [ObjectIdentifier: URLSessionDataTask] = [:]
    private var answered = Set<Int>()
    private var awake: NSObjectProtocol?
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.timeoutIntervalForRequest = 900  // a fetch can take minutes before its first byte
        config.timeoutIntervalForResource = 3600
        return URLSession(configuration: config, delegate: self, delegateQueue: .main)
    }()

    func webView(_ view: WKWebView, start task: WKURLSchemeTask) {
        live.insert(ObjectIdentifier(task))
        let path = task.request.url?.path ?? "/"
        if path.hasPrefix("/api/") {
            proxy(task, String(path.dropFirst(4)))
        } else if path.hasPrefix("/native/") {
            native(task, String(path.dropFirst(8)))
        } else {
            file(task, path)
        }
    }

    func webView(_ view: WKWebView, stop task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        live.remove(id)
        upstream.removeValue(forKey: id)?.cancel()
    }

    private func file(_ task: WKURLSchemeTask, _ path: String) {
        guard let url = task.request.url else { return }
        let name = path == "/" ? "index.html" : String(path.dropFirst())
        let file = root.appendingPathComponent(name).standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
            return reply(task, 404, ["error": ["code": "not_found", "message": "no such page"]])
        }
        task.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": types[file.pathExtension] ?? "application/octet-stream"])!)
        task.didReceive(data)
        task.didFinish()
        live.remove(ObjectIdentifier(task))
    }

    private func reply(_ task: WKURLSchemeTask, _ status: Int, _ object: Any) {
        guard let url = task.request.url, live.remove(ObjectIdentifier(task)) != nil else { return }
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
        task.didReceive(HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                        headerFields: ["Content-Type": "application/json"])!)
        task.didReceive(data)
        task.didFinish()
    }

    private func body(of request: URLRequest) -> Data? {
        if let data = request.httpBody { return data }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(contentsOf: buffer[0..<n])
        }
        return data
    }

    private func proxy(_ task: WKURLSchemeTask, _ path: String) {
        guard path.hasPrefix("/beetle/") || path.hasPrefix("/v1/") else {
            return reply(task, 404, ["error": ["code": "not_found", "message": "no such route"]])
        }
        let payload = body(of: task.request)
        daemon.ready { [self] ok in
            guard live.contains(ObjectIdentifier(task)) else { return }
            guard ok, let base = daemon.base, let token = daemon.token else {
                return reply(task, 503, ["error": nothingAnswers()])
            }
            var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
            parts.path = path
            parts.percentEncodedQuery = task.request.url.flatMap {
                URLComponents(url: $0, resolvingAgainstBaseURL: false)?.percentEncodedQuery
            }
            var request = URLRequest(url: parts.url!)
            request.httpMethod = task.request.httpMethod
            request.httpBody = payload
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            let call = session.dataTask(with: request)
            pending[call.taskIdentifier] = task
            upstream[ObjectIdentifier(task)] = call
            call.resume()
        }
    }

    /// What stands in the way, in words that say what to do. Not set up isn't a failure.
    private func nothingAnswers() -> [String: String] {
        if !FileManager.default.isExecutableFile(atPath: beetleBin) {
            return ["code": "not_installed", "message": "The app needs Beetle's background service. The app's README has the steps."]
        }
        if readJSON("config.json") == nil {
            return ["code": "not_set_up", "message": "Run `beetle init --local-only` to use models on this Mac, or `beetle init --chain chain.json --per-job 5 --per-day 10 --min-tier public` to join a network."]
        }
        return ["code": "no_daemon", "message": daemon.outdated
            ? "Beetle's background service is older than this app. Update Beetle, then reopen the app."
            : "Beetle's background service isn't ready. If macOS asked for access to your Desktop folder, allow it."]
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        defer { completionHandler(.allow) }
        guard let task = pending[dataTask.taskIdentifier], live.contains(ObjectIdentifier(task)),
              let http = response as? HTTPURLResponse, let url = task.request.url else { return }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            let name = "\(key)".lowercased()
            if name == "content-type" || name.hasPrefix("x-beetle-") { headers[name] = "\(value)" }
        }
        answered.insert(dataTask.taskIdentifier)
        task.didReceive(HTTPURLResponse(url: url, statusCode: http.statusCode, httpVersion: "HTTP/1.1", headerFields: headers)!)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        if let task = pending[dataTask.taskIdentifier], live.contains(ObjectIdentifier(task)) {
            task.didReceive(data)
        }
    }

    func urlSession(_ session: URLSession, task call: URLSessionTask, didCompleteWithError error: Error?) {
        guard let task = pending.removeValue(forKey: call.taskIdentifier) else { return }
        let id = ObjectIdentifier(task)
        upstream[id] = nil
        let replied = answered.remove(call.taskIdentifier) != nil
        guard live.contains(id) else { return }
        if let error {
            daemon.lost()
            if replied {
                live.remove(id)
                task.didFailWithError(error)
            } else {
                reply(task, 503, ["error": ["code": "no_daemon", "message": "Lost the background service."]])
            }
        } else {
            live.remove(id)
            task.didFinish()
        }
    }

    private func background(_ task: WKURLSchemeTask, _ work: @escaping () -> Any) {
        DispatchQueue.global().async {
            let out = work()
            DispatchQueue.main.async { self.reply(task, 200, out) }
        }
    }

    private func native(_ task: WKURLSchemeTask, _ path: String) {
        let input = body(of: task.request).flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        let parts = path.split(separator: "/").map(String.init)
        switch parts.first {
        case "info":
            reply(task, 200, ["network": readJSON("chain.json")?["network"] ?? "unknown",
                              "api": daemon.base?.absoluteString ?? "", "dev": Bridge.source != nil])
        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(input["text"] as? String ?? "", forType: .string)
            reply(task, 200, ["ok": true])
        case "awake":
            keepAwake(input["on"] as? Bool == true)
            reply(task, 200, ["ok": true])
        case "tray":
            onTray?(input["lines"] as? [String] ?? [])
            reply(task, 200, ["ok": true])
        case "agents" where parts.count == 1:
            background(task) { ["agents": Agents.list()] }
        case "agents" where parts.count == 3 && Agents.all.contains { $0.0 == parts[1] }:
            background(task) {
                let failed = parts[2] == "connect" ? Agents.connect(parts[1]) : Agents.disconnect(parts[1])
                return ["ok": failed == nil, "error": failed ?? ""]
            }
        case "host" where parts.count == 1:
            background(task) { self.host.report() }
        case "host" where parts.count == 2 && parts[1] == "list":
            background(task) {
                let failed = self.host.list(model: input["model"] as? String ?? "", input: input["in"] as? Double ?? 0,
                                            output: input["out"] as? Double ?? 0, slots: input["slots"] as? Int ?? 1)
                return ["ok": failed == nil, "error": failed ?? ""]
            }
        case "host" where parts.count == 2 && parts[1] == "serve":
            let on = input["on"] as? Bool == true
            background(task) {
                let failed = on ? self.host.start() : { self.host.stop(); return nil }()
                return ["ok": failed == nil, "error": failed ?? ""]
            }
        default:
            reply(task, 404, ["error": ["code": "not_found", "message": "no such call"]])
        }
    }

    /// The key has to go out while a job waits for it, so a job holds off idle sleep.
    private func keepAwake(_ on: Bool) {
        if on, awake == nil {
            awake = ProcessInfo.processInfo.beginActivity(options: .idleSystemSleepDisabled, reason: "A Beetle job is running")
        } else if !on, let held = awake {
            ProcessInfo.processInfo.endActivity(held)
            awake = nil
        }
    }
}

/// The window has no title bar, so this strip along the top edge is what drags it.
final class DragStrip: NSView {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.performZoom(nil)
        } else {
            window?.performDrag(with: event)
        }
    }
}

final class App: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var web: WKWebView!
    private var item: NSStatusItem!
    private var trayLines: [NSMenuItem] = []
    private let bridge = Bridge()

    private func option(_ name: String) -> String? {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
        return args[i + 1]
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.mainMenu = mainMenu()
        makeWindow()
        makeStatusItem()
        bridge.onTray = { [weak self] lines in self?.setTray(lines) }
        show()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }

    func applicationWillTerminate(_ note: Notification) {
        bridge.host.stop()
    }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        show()
        return true
    }

    @objc func reload() {
        web.reload()
    }

    @objc func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func makeWindow() {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(bridge, forURLScheme: "beetle")
        let frame = NSRect(x: 0, y: 0, width: 1200, height: 780)
        web = WKWebView(frame: frame, configuration: config)
        web.navigationDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = Bridge.source != nil }
        web.autoresizingMask = [.width, .height]
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: frame,
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "Beetle Desktop"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 980, height: 640)
        window.center()
        window.setFrameAutosaveName("Beetle")  // may restore a size other than `frame`
        let content = window.contentView!
        web.frame = content.bounds
        content.addSubview(web)

        let strip = DragStrip(frame: NSRect(x: 0, y: content.bounds.height - 28, width: content.bounds.width, height: 28))
        strip.autoresizingMask = [.width, .minYMargin]
        content.addSubview(strip)

        web.load(URLRequest(url: URL(string: "beetle://app/#\(option("--page") ?? "overview")")!))
    }

    private func makeStatusItem() {
        item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let url = Bundle.main.url(forResource: "menubar", withExtension: "svg"),
           let image = NSImage(contentsOf: url) {
            image.size = NSSize(width: 18, height: 18)
            image.isTemplate = true
            item.button?.image = image
        } else {
            item.button?.title = "B"
        }
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.addItem(withTitle: "Open Beetle Desktop", action: #selector(show), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit Beetle Desktop", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        item.menu = menu
    }

    private func setTray(_ lines: [String]) {
        guard let menu = item.menu else { return }
        trayLines.forEach(menu.removeItem)
        trayLines = lines.enumerated().map { i, line in
            let row = NSMenuItem(title: line, action: nil, keyEquivalent: "")
            row.isEnabled = false
            menu.insertItem(row, at: i)
            return row
        }
    }

    private func attach(_ menu: NSMenu, _ title: String, to main: NSMenu) {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.submenu = menu
        main.addItem(item)
    }

    private func mainMenu() -> NSMenu {
        let main = NSMenu()
        let app = NSMenu()
        app.addItem(withTitle: "Hide Beetle Desktop", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit Beetle Desktop", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        attach(app, "Beetle Desktop", to: main)

        // Without these, Command-C and Command-V do nothing in a web view.
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        attach(edit, "Edit", to: main)

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
        attach(view, "View", to: main)

        let windows = NSMenu(title: "Window")
        windows.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windows.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        attach(windows, "Window", to: main)
        NSApp.windowsMenu = windows
        return main
    }

    /// Only this app's own pages load here; an outside link goes to the browser.
    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url, url.scheme != "beetle" else { return decisionHandler(.allow) }
        if url.scheme == "https" { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    // `Beetle --snapshot file.png [--page market] [--wait 8]` checks the real page in
    // the real web view, then quits.
    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) {
        guard let path = option("--snapshot") else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + (Double(option("--wait") ?? "") ?? 1)) {
            view.takeSnapshot(with: nil) { image, _ in
                if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                NSApp.terminate(nil)
            }
        }
    }
}

let application = NSApplication.shared
let delegate = App()
application.delegate = delegate
application.run()
