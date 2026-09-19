import Foundation
import WebKit

/// Serves the bundled web app over a custom scheme.
///
/// Loading the page from a file:// URL also works, but WKWebView gives file URLs an opaque
/// origin, so `localStorage` is unavailable and a child's stars would vanish on every
/// launch. A custom scheme gives the page one stable origin, so progress persists. The app
/// already copes with storage throwing, but there is no reason to make it.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "cubeclubhouse"
    static let host = "app"
    static var startURL: URL { URL(string: "\(scheme)://\(host)/index.html")! }

    /// The bundled copy of the web app, written by the "Copy web app into bundle" phase.
    private let root = Bundle.main.url(forResource: "Web", withExtension: nil)

    private static let mimeTypes = [
        "html": "text/html; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "woff2": "font/woff2",
    ]

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let root else {
            fail(task, "The web app is missing from the bundle. Check the Copy web app build phase.")
            return
        }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }

        // Resolve inside the bundle, and refuse anything that climbs out of it.
        let file = root.appendingPathComponent(path).standardizedFileURL
        guard file.path.hasPrefix(root.standardizedFileURL.path + "/") || file == root else {
            fail(task, "Refused a path outside the bundle: \(path)")
            return
        }
        guard let data = try? Data(contentsOf: file) else {
            fail(task, "Not in the bundle: \(path)")
            return
        }

        let mime = Self.mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let response = HTTPURLResponse(
            url: url, statusCode: 200, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mime, "Content-Length": String(data.count)])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, _ message: String) {
        NSLog("Cube Clubhouse: %@", message)
        task.didFailWithError(NSError(domain: "CubeClubhouse", code: 404,
                                      userInfo: [NSLocalizedDescriptionKey: message]))
    }
}
