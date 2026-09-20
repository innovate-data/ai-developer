//
//  Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
//  Proprietary software. See LICENSE, or the Licence page inside the app.
//

import SwiftUI

/// Cube Clubhouse for iPhone and iPad.
///
/// The teaching app itself is the web app in the parent folder; this target hosts it in a
/// WKWebView and does the few things a web page cannot do for itself on iOS. The page is
/// copied into the bundle by the "Copy web app into bundle" build phase, so there is only
/// ever one copy of the lessons, the solver and the cube model.
@main
struct CubeClubhouseApp: App {
    var body: some Scene {
        WindowGroup {
            WebAppView()
                // The page paints its own background and handles the notch and the home
                // indicator through CSS env(safe-area-inset-*), so let it run edge to edge.
                .ignoresSafeArea()
        }
    }
}
