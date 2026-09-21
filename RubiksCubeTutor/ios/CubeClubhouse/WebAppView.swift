//
//  Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
//  Proprietary software. See LICENSE, or the Licence page inside the app.
//

import SwiftUI
import WebKit

/// Hosts the bundled web app.
struct WebAppView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(context.coordinator.schemeHandler,
                                   forURLScheme: BundleSchemeHandler.scheme)
        // The page asks to buy or restore through this channel; the answer goes back
        // through evaluateJavaScript below. See js/store.js.
        config.userContentController.add(context.coordinator, name: "store")
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

        let webView = WKWebView(frame: .zero, configuration: config)
        context.coordinator.webView = webView
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false                       // no rubber-banding
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.allowsBackForwardNavigationGestures = false      // the app has its own nav
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }   // Safari > Develop
        #endif

        webView.load(URLRequest(url: BundleSchemeHandler.startURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    /// SwiftUI is finished with the view. `WKUserContentController` holds a script
    /// message handler strongly, so without this the coordinator - and the web view's
    /// whole configuration - outlive the screen they belong to.
    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "store")
        Task { @MainActor in coordinator.stop() }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let schemeHandler = BundleSchemeHandler()
        let store = StoreManager()
        weak var webView: WKWebView?
        private var pageIsUp = false

        /// Called from `dismantleUIView`.
        func stop() { store.stopListening() }

        override init() {
            super.init()
            store.onChange = { [weak self] unlocked, price, ready in
                self?.send(unlocked: unlocked, price: price, ready: ready, result: nil)
            }
        }

        /// Tell the page what StoreKit says. Always on the main thread, and only once
        /// the page exists to hear it.
        private func send(unlocked: Bool, price: String?, ready: Bool, result: [String: Any]?) {
            guard pageIsUp, let webView else { return }
            var state: [String: Any] = ["unlocked": unlocked, "shopReady": ready]
            if let price { state["price"] = price }
            if let result { state["result"] = result }
            guard let data = try? JSONSerialization.data(withJSONObject: state),
                  let json = String(data: data, encoding: .utf8) else { return }
            webView.evaluateJavaScript("window.RC && window.RC.Store && window.RC.Store.applyNative(\(json));")
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "store",
                  let body = message.body as? [String: Any],
                  let action = body["action"] as? String else { return }
            Task { @MainActor in
                switch action {
                case "sync":
                    await store.start()
                case "buy":
                    let outcome = await store.purchase()
                    send(unlocked: store.isUnlocked, price: store.priceText, ready: store.product != nil,
                         result: Self.describe(outcome))
                case "restore":
                    let outcome = await store.restore()
                    send(unlocked: store.isUnlocked, price: store.priceText, ready: store.product != nil,
                         result: Self.describe(outcome))
                default:
                    break
                }
            }
        }

        private static func describe(_ outcome: StoreManager.Outcome) -> [String: Any] {
            switch outcome {
            case .bought:            return ["ok": true]
            case .cancelled:         return ["ok": false, "reason": "cancelled"]
            case .pending:           return ["ok": false, "reason": "pending",
                                             "message": "Someone needs to approve this purchase. It will unlock as soon as they do."]
            case .nothingToRestore:  return ["ok": false, "reason": "nothing-to-restore"]
            case .unavailable:       return ["ok": false, "reason": "unavailable",
                                             "message": "The shop is not reachable just now. Please try again later."]
            case .failed(let why):   return ["ok": false, "reason": "failed", "message": why]
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
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            } else {
                // stylesheets and fonts the page fetches over https
                decisionHandler(.allow)
            }
        }

        /// The page is ready: check with StoreKit and tell it what is owned.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            pageIsUp = true
            Task { @MainActor in await store.start() }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("Cube Clubhouse failed to load: \(error.localizedDescription)")
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("Cube Clubhouse failed to start: \(error.localizedDescription)")
        }
    }
}
