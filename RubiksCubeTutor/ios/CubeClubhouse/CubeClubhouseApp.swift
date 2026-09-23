//
//  Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved.
//  Proprietary software. See LICENSE, or the Licence page inside the app.
//

import SwiftUI

/// Cube Clubhouse® for iPhone and iPad.
///
/// The teaching app itself is the web app in the parent folder; this target hosts it in a
/// WKWebView and does the few things a web page cannot do for itself on iOS. The page is
/// copied into the bundle by the "Copy web app into bundle" build phase, so there is only
/// ever one copy of the lessons, the solver and the cube model.
@main
struct CubeClubhouseApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

/// The web app, with the launch screen held over it until the page has loaded.
///
/// iOS shows the launch screen (Info.plist, UILaunchScreen) only until the app draws its
/// first frame, and that comes before the bundled page has finished loading. Without this
/// view the logo would vanish into an empty background for a moment and then the app would
/// pop in. LaunchCover draws the launch screen again, the same colour and the same image
/// in the same place, and fades it away once the page says it is ready.
struct RootView: View {
    @State private var ready = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            // Behind the page too, so nothing flashes while it draws its first frame.
            Color("LaunchBackground")
            WebAppView(onReady: reveal)
            if !ready {
                LaunchCover()
                    .transition(.opacity)
            }
        }
        // The page paints its own background and handles the notch and the home
        // indicator through CSS env(safe-area-inset-*), so let it run edge to edge.
        .ignoresSafeArea()
        .onAppear {
            // The page always reports back, but a child must never be left looking at
            // the logo if it somehow does not: uncover after a few seconds regardless.
            DispatchQueue.main.asyncAfter(deadline: .now() + 4) { reveal() }
        }
    }

    private func reveal() {
        guard !ready else { return }
        if reduceMotion {
            ready = true
        } else {
            withAnimation(.easeOut(duration: 0.35)) { ready = true }
        }
    }
}

/// The launch screen, drawn again in SwiftUI so the hand-over cannot be seen: the
/// LaunchBackground colour, and the LaunchLogo image at its own size, centred on the
/// whole screen, exactly as UILaunchScreen places it.
struct LaunchCover: View {
    var body: some View {
        ZStack {
            Color("LaunchBackground")
            Image("LaunchLogo")
                .accessibilityLabel("Cube Clubhouse")
        }
        .ignoresSafeArea()
    }
}
