//
//  Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
//  Proprietary software. See LICENSE, or the Licence page inside the app.
//

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
        "mp4": "video/mp4",
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
        // Mapped rather than read, so asking for a slice of the video does not load it all.
        guard let data = try? Data(contentsOf: file, options: .mappedIfSafe) else {
            fail(task, "Not in the bundle: \(path)")
            return
        }

        let mime = Self.mimeTypes[file.pathExtension.lowercased()] ?? "application/octet-stream"
        var status = 200
        var body = data
        var headers = ["Content-Type": mime, "Accept-Ranges": "bytes"]
        // A video asks for its bytes a piece at a time ("Range: bytes=0-1"), and WebKit will
        // not play one whose loader cannot answer that. Everything else takes the whole file.
        if let header = task.request.value(forHTTPHeaderField: "Range"),
           let range = Self.byteRange(header, size: data.count) {
            status = 206
            body = data.subdata(in: range.from ..< range.to + 1)
            headers["Content-Range"] = "bytes \(range.from)-\(range.to)/\(data.count)"
        }
        headers["Content-Length"] = String(body.count)
        let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: headers)!
        task.didReceive(response)
        task.didReceive(body)
        task.didFinish()
    }

    /// "bytes=100-199", "bytes=100-" (to the end) or "bytes=-500" (the last 500), kept
    /// inside the file. Anything else, including several ranges at once, is nil, and is
    /// answered with the whole file. tests/ios-bundle-tests.js serves ranges the same way.
    static func byteRange(_ header: String, size: Int) -> (from: Int, to: Int)? {
        guard size > 0, header.hasPrefix("bytes="), !header.contains(",") else { return nil }
        let spec = header.dropFirst(6).split(separator: "-", omittingEmptySubsequences: false)
        guard spec.count == 2 else { return nil }
        let first = spec[0].trimmingCharacters(in: .whitespaces)
        let last = spec[1].trimmingCharacters(in: .whitespaces)
        if first.isEmpty {
            guard let count = Int(last), count > 0 else { return nil }
            return (from: max(0, size - count), to: size - 1)
        }
        guard let from = Int(first), from >= 0, from < size else { return nil }
        let to = last.isEmpty ? size - 1 : min(Int(last) ?? size - 1, size - 1)
        return to >= from ? (from: from, to: to) : nil
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func fail(_ task: WKURLSchemeTask, _ message: String) {
        NSLog("Cube Clubhouse: %@", message)
        task.didFailWithError(NSError(domain: "CubeClubhouse", code: 404,
                                      userInfo: [NSLocalizedDescriptionKey: message]))
    }
}
