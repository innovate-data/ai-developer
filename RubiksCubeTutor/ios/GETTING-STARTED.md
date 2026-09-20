# Deploying Cube Clubhouse to an iPhone or iPad

Everything needed is in this folder. There is no package manager, no project
generator and no build script to run first.

## 1. Open it

```sh
open ios/CubeClubhouse.xcodeproj
```

Xcode 14 or newer. The project targets iOS 15, and builds for both iPhone and iPad.

## 2. Set your team and bundle identifier

Select the **CubeClubhouse** target, then **Signing & Capabilities**:

- **Team**: choose your own Apple Developer team.
- **Bundle Identifier**: change `com.example.cubeclubhouse` to something of your
  own, such as `com.yourname.cubeclubhouse`. Apple requires this to be unique.

A free Apple ID is enough to run on your own device; a paid Developer account is
needed for TestFlight or the App Store.

## 3. Run

Pick a simulator or your connected device and press **Run** (⌘R).

On a device, the first launch needs you to trust the certificate:
**Settings → General → VPN & Device Management → your developer certificate → Trust**.

## What is inside

| Path | What it is |
|------|------------|
| `ios/CubeClubhouse.xcodeproj` | The Xcode project |
| `ios/CubeClubhouse/*.swift` | Three files: the app, the web view host, the bundle server |
| `ios/CubeClubhouse/Assets.xcassets` | App icon (1024×1024, no alpha) and accent colour |
| `index.html`, `css/`, `js/` | The app itself: lessons, solver, cube models, 3D view |
| `tests/` | Test suites, not part of the app bundle |

The app is the web app in the parent folder, hosted in a `WKWebView`. A build phase
named **Copy web app into bundle** copies `index.html`, `css/` and `js/` into the app
bundle every time you build, so there is only one copy of the code and editing the
web app then pressing Run is enough.

**Keep this folder structure.** The copy phase reads from the folder above `ios/`.
If you move `CubeClubhouse.xcodeproj` somewhere else on its own, the build stops with
a message telling you so.

## Changing the app's name

The name under the icon comes from `INFOPLIST_KEY_CFBundleDisplayName` in the target's
build settings. Change it there; you do not need to rename files or the scheme.

## Uploading to the App Store

1. Set a real bundle identifier and a paid team, as above.
2. Bump `MARKETING_VERSION` (the version people see) and `CURRENT_PROJECT_VERSION`
   (the build number) in the target's build settings.
3. **Product → Archive**, then **Distribute App**.

The icon already meets Apple's requirement of 1024×1024 with no alpha channel. The app
requests no permissions, collects nothing and has no network calls of its own, so App
Privacy is "Data Not Collected". One caveat: the page asks Google Fonts for its
typeface and falls back to the system rounded font when offline, so declare no tracking
but be aware of that one outbound request, or bundle the font to remove it.

## Known scope

The 2×2 and 3×3 have a full guided solve. The 4×4, 5×5 and 6×6 are free play: you can
turn, mix and reset them, but the app does not teach the reduction method those sizes
need. The Learn lessons and "My real cube" are 3×3.
