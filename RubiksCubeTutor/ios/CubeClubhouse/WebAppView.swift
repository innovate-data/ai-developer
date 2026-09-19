import SwiftUI
import WebKit

/// Hosts the bundled web app.
struct WebAppView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

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
        if #available(iOS 16.4, *) { webView.isInspectable = true }   // Safari > Develop
        #endif

        webView.load(URLRequest(url: BundleSchemeHandler.startURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: NSObject, WKNavigationDelegate {
        let schemeHandler = BundleSchemeHandler()

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

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            NSLog("Cube Clubhouse failed to load: \(error.localizedDescription)")
        }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            NSLog("Cube Clubhouse failed to start: \(error.localizedDescription)")
        }
    }
}
