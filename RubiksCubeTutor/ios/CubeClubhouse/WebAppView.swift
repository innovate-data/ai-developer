//
//  Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
//  Proprietary software. See LICENSE, or the Licence page inside the app.
//

import SwiftUI
import WebKit

/// Hosts the bundled web app.
struct WebAppView: UIViewRepresentable {
    /// Blocks every http(s) load the web view could possibly make.
    ///
    /// The app has nothing to fetch: the page, the styles, the scripts and the typeface
    /// all come out of the bundle over `cubeclubhouse://`, which this rule never matches.
    /// It is here so that stays true - a stray `<img src="https://...">` or a pasted
    /// analytics snippet would be blocked by WebKit itself, not merely absent today.
    /// The page carries a Content-Security-Policy saying the same thing; this is the
    /// half a web page cannot switch off.
    ///
    /// Links a child actually taps are unaffected: `decidePolicyFor` below cancels them
    /// and hands them to Safari before any load begins.
    private static let blockAllNetworkLoads = """
    [{"trigger": {"url-filter": "^https?://"}, "action": {"type": "block"}}]
    """

    /// Called when the bundled page has loaded (or failed to), so RootView can take the
    /// launch screen down. It may be called more than once; RootView acts on the first.
    var onReady: () -> Void = {}

    func makeCoordinator() -> Coordinator { Coordinator(onReady: onReady) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator.schemeHandler,
                                   forURLScheme: BundleSchemeHandler.scheme)
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Spinning the cube is a drag gesture, and a stray second finger would otherwise
        // zoom the page mid-spin. Pin the viewport so pinch and double-tap do nothing.
        let pinViewport = """
        var m = document.querySelector('meta[name=viewport]');
        if (!m) { m = document.createElement('meta'); m.name = 'viewport'; document.head.appendChild(m); }
        m.setAttribute('content',
          'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover');
        """
        config.userContentController.addUserScript(
            WKUserScript(source: pinViewport, injectionTime: .atDocumentEnd, forMainFrameOnly: true))

        // Tell the page it is the iOS app, and on which device, so it can say "this iPad"
        // rather than "this browser" and speak the platform's own words; and which version
        // this is and whether the update check is on, for the About page's Updates section.
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        let updates = UpdateChecker.shared
        let version = updates.installedVersion.filter { $0.isNumber || $0 == "." }
        let host = "window.CubeClubhouseHost = Object.freeze({ platform: 'ios', device: '\(device)', "
            + "version: '\(version)', updateCheck: \(updates.enabled) });"
        config.userContentController.addUserScript(
            WKUserScript(source: host, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        // Haptics: the page asks, the device answers. iPad has no haptic engine, so there
        // the generators simply do nothing.
        config.userContentController.add(context.coordinator, name: "haptic")
        // The About page's Updates switch and Check Now button (UpdateChecker).
        config.userContentController.add(context.coordinator, name: "updates")

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false                       // no rubber-banding
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.allowsBackForwardNavigationGestures = false      // the app has its own nav
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        context.coordinator.webView = webView
        context.coordinator.followTextSize()
        #if DEBUG
        webView.isInspectable = true                             // Safari > Develop > device
        #endif

        // Install the blocker, then load. If WebKit cannot compile the rule - it is the
        // only part of this that can fail at runtime - the app still opens and the page's
        // own Content-Security-Policy still blocks the network, so this fails open.
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "CubeClubhouseBlockNetwork",
            encodedContentRuleList: Self.blockAllNetworkLoads
        ) { list, error in
            DispatchQueue.main.async {
                if let list = list {
                    webView.configuration.userContentController.add(list)
                } else {
                    NSLog("Cube Clubhouse: network blocker unavailable (%@); the page's CSP still applies",
                          error?.localizedDescription ?? "unknown")
                }
                webView.load(URLRequest(url: BundleSchemeHandler.startURL))
            }
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let schemeHandler = BundleSchemeHandler()
        let onReady: () -> Void
        weak var webView: WKWebView?
        private var textSizeObserver: NSObjectProtocol?

        init(onReady: @escaping () -> Void) {
            self.onReady = onReady
            super.init()
        }

        deinit {
            if let textSizeObserver = textSizeObserver {
                NotificationCenter.default.removeObserver(textSizeObserver)
            }
        }

        /// Settings > Display & Brightness > Text Size (and the larger Accessibility sizes)
        /// makes every iOS app's text bigger; this makes the page follow. The page is laid
        /// out for the standard size, so it only ever grows, and by at most a quarter,
        /// which keeps every screen inside the width of the smallest iPhone.
        func followTextSize() {
            apply()
            if textSizeObserver == nil {
                textSizeObserver = NotificationCenter.default.addObserver(
                    forName: UIContentSizeCategory.didChangeNotification, object: nil, queue: .main
                ) { [weak self] _ in self?.apply() }
            }
        }

        private func apply() {
            let scale = UIFont.preferredFont(forTextStyle: .body).pointSize / 17
            webView?.pageZoom = min(max(scale, 1), 1.25)
        }

        /// window.webkit.messageHandlers.haptic.postMessage("light" | "medium" | "success" | "warning")
        /// window.webkit.messageHandlers.updates.postMessage({ action: "set", enabled: true | false })
        /// window.webkit.messageHandlers.updates.postMessage({ action: "check" })
        func userContentController(_ userContentController: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            if message.name == "updates" { updates(message.body); return }
            guard message.name == "haptic", let kind = message.body as? String else { return }
            switch kind {
            case "light": UIImpactFeedbackGenerator(style: .light).impactOccurred()
            case "medium": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case "success": UINotificationFeedbackGenerator().notificationOccurred(.success)
            case "warning": UINotificationFeedbackGenerator().notificationOccurred(.warning)
            default: break
            }
        }

        private func updates(_ body: Any) {
            guard let body = body as? [String: Any], let action = body["action"] as? String else { return }
            switch action {
            case "set":
                if let on = body["enabled"] as? Bool { UpdateChecker.shared.enabled = on }
            case "check":
                UpdateChecker.shared.checkNow { [weak self] outcome, version in
                    // Only the outcome and a version number go back to the page: both are
                    // plain, so this string cannot carry anything else into it.
                    let v = (version ?? "").filter { $0.isNumber || $0 == "." }
                    let js = "window.CubeClubhouseUpdates && window.CubeClubhouseUpdates.result("
                        + "{ outcome: '\(outcome.rawValue)', version: '\(v)' })"
                    self?.webView?.evaluateJavaScript(js, completionHandler: nil)
                }
            default: break
            }
        }

        /// Keep in-app navigation inside the bundle; send real links to Safari.
        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel); return
            }
            if url.scheme == BundleSchemeHandler.scheme {
                decisionHandler(.allow)
            } else if navigationAction.navigationType == .linkActivated {
                // A link the child deliberately tapped: hand it to Safari, where a
                // grown-up can see where they are. The app itself still loads nothing.
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                // Everything the app needs is in the bundle, so anything else is either a
                // mistake or something we did not put there. Refuse it.
                NSLog("Cube Clubhouse: refused a navigation off the bundle: %@", url.absoluteString)
                decisionHandler(.cancel)
            }
        }

        /// The page and its scripts have loaded: the launch screen can go.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            onReady()
        }

        // On a failure, uncover anyway: an error page is better than a logo that never goes.
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("Cube Clubhouse failed to load: \(error.localizedDescription)")
            onReady()
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("Cube Clubhouse failed to start: \(error.localizedDescription)")
            onReady()
        }
    }
}
