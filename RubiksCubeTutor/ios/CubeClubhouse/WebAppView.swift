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

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false                       // no rubber-banding
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.allowsBackForwardNavigationGestures = false      // the app has its own nav
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
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

    final class Coordinator: NSObject, WKNavigationDelegate {
        let schemeHandler = BundleSchemeHandler()
        let onReady: () -> Void

        init(onReady: @escaping () -> Void) {
            self.onReady = onReady
            super.init()
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
