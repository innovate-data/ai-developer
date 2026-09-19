# Cube Clubhouse for iPhone and iPad

An Xcode project that ships the Cube Clubhouse web app as a native iOS app.

```sh
open ios/CubeClubhouse.xcodeproj
```

Pick a simulator or your device and press Run. Nothing to install first: no CocoaPods,
no Swift packages, no `xcodegen`.

| | |
|---|---|
| Deployment target | iOS 15.0 |
| Devices | iPhone and iPad, all orientations |
| Bundle identifier | `com.example.cubeclubhouse`, change it to your own |
| Signing | Automatic. Pick your team under Signing & Capabilities before running on a device. |

## How it is put together

Three small Swift files host the web app; the lessons, the solver and the cube model are
the same JavaScript the browser version runs.

- **`CubeClubhouseApp.swift`** is the SwiftUI entry point. It lets the web view run edge
  to edge, because the page already handles the notch and the home indicator itself
  through CSS `env(safe-area-inset-*)`.
- **`WebAppView.swift`** wraps `WKWebView`. It turns off bounce scrolling and pinch zoom,
  so a second finger cannot zoom the page while a child is dragging the cube around, and
  it sends real links out to Safari.
- **`BundleSchemeHandler.swift`** serves the bundled files over a `cubeclubhouse://`
  scheme. Loading them from a `file://` URL also works, but WKWebView gives file URLs an
  opaque origin, so `localStorage` is unavailable and a child's stars would vanish on
  every launch. A custom scheme gives the page one stable origin instead.

## There is only one copy of the web app

The `ios/` folder contains no HTML, CSS or JavaScript. A build phase named **Copy web app
into bundle** copies `index.html`, `css/` and `js/` from the parent folder into the app
bundle on every build, so editing the web app and pressing Run in Xcode is enough. The
consequence is that the Xcode project must stay where it is, inside `RubiksCubeTutor/`.
Move it somewhere else and the build stops with a message saying so.

## What has been tested, and what has not

`npm run test:ios` extracts that copy phase from the Xcode project, runs it with the same
variables Xcode sets, then serves the resulting bundle with the same MIME types the
scheme handler uses and drives the app by touch on an iPhone and an iPad profile. It
checks the app loads from a real origin, that stars survive a relaunch, that a tap-only
solve reaches a solved cube, that the sticker grid is tappable, and that nothing scrolls
sideways.

**That harness runs Chromium, not WebKit**, because no WebKit build was available where
this was written, and neither was Xcode. So the web app is well covered, but the Swift
code has never been compiled and the app has never run in the Simulator. Expect to spend
a few minutes on the first run. If something does go wrong, the likely spots are the
signing team, which you have to choose yourself, and the copy phase, which prints what it
did to the build log.

## Things worth knowing

- **Fonts.** The page asks Google Fonts for Fredoka. With no network it falls back to
  `ui-rounded`, which is SF Pro Rounded on iOS and suits the app well. Everything else
  works offline. Bundle the font if you want the same look on a plane.
- **App icon.** `Assets.xcassets/AppIcon.appiconset/AppIcon.png` is a 1024×1024 image with
  no alpha channel, which is what the App Store requires.
- **Safari Web Inspector** is enabled in Debug builds, so you can inspect the running page
  from Safari's Develop menu while the app is on a simulator or a device.
