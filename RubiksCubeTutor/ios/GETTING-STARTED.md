# Deploying Cube Clubhouse to an iPhone or iPad

Everything needed is in this folder. There is no package manager, no project
generator and no build script to run first.

## 1. Open it

```sh
open ios/CubeClubhouse.xcodeproj
```

Xcode 15 or newer, which is the first with the iOS 17 SDK. The project targets iOS 17,
and builds for both iPhone and iPad.

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
requests no permissions, collects nothing and makes no network requests whatsoever, so
App Privacy is "Data Not Collected" with no caveats: the typeface ships inside the
bundle, the page carries a `Content-Security-Policy` that forbids loading anything over
http(s), and `WebAppView` installs a `WKContentRuleList` that blocks such loads at the
WebKit level. You can demonstrate all of this by running the app in aeroplane mode.

The **Copyright** field App Store Connect asks for is already set in the target's build
settings as "Copyright © 2026 Ira Learning LLC. All rights reserved."; the app is
proprietary, and `LICENSE` beside the app holds the terms shown on its Licence page.

Two things to settle before you submit:

* **A privacy policy URL.** App Store Connect wants one you host. The wording is already
  written — it is the Privacy section of the in-app **For grown-ups** page (the footer
  links lead there) — so put the same text on a page of your own and link to that.
* **Who to contact.** The in-app page deliberately gives no address, because there is
  nothing to request or delete. If you want one shown, add it to the end of the Privacy
  section in `index.html`.

The app is free with no purchases, no subscriptions and no advertising, so there is
nothing to declare under in-app purchases and nothing to price. If you publish in the
Kids category, note that it also has no external links, so no parental gate is needed.

## Known scope

Every part of the app is free to use, with nothing held back and nothing to buy.
Every size from 2×2 to 6×6 has a guided solve on the Play screen. The 4×4, 5×5 and
6×6 use the reduction method (centres, then edge pairing, then the 3×3 method), so a
6×6 solve is long, around 95 cards. Working one out is real arithmetic: about a
second on a recent iPad and up to six on an older iPhone, so the app does it a slice
at a time, says what it is doing ("Thinking… joining the edges") and holds the Play
controls until it is ready, rather than freezing. The tables it builds are kept for
the size in play only, about 30 MB at the largest. The Learn lessons and "My real
cube" are 3×3.

## Which iOS versions

The deployment target is **iOS 17.0**, on iPhone and iPad, portrait and landscape, and
in Split View, Slide Over and Stage Manager (the target does not require full screen).
`npm run test:ios` fails if either build configuration drifts off 17.0.

**This is a floor, not a requirement.** Nothing in the app needs iOS 17; it was built to
run on iOS 15 and did. If you would rather reach older hardware — an iPad 5th generation
or an iPhone X stops at iOS 16, and those are exactly the hand-me-down devices children
get — set `IPHONEOS_DEPLOYMENT_TARGET` back to `15.0` in both configurations and change
the one test that asserts 17.0. The only code that assumed 17 is `webView.isInspectable`,
which then needs its `if #available(iOS 16.4, *)` guard back.

Everything the app calls was audited against iOS 17:

| | |
|---|---|
| SwiftUI, WKWebView, the custom scheme handler | iOS 15 era, nothing deprecated in 17 |
| `WKContentRuleListStore` (the network blocker) | iOS 11 |
| `webView.isInspectable` | iOS 16.4, so no `#available` guard is needed at this target |
| The web app's CSS | nothing newer than Safari 15.4; `:focus-visible`, `aspect-ratio`, `clamp()`, `env()` and flexbox `gap` are the newest things in it |
| The web app's JavaScript | no `Object.groupBy`, no `Promise.withResolvers`, no `Array.fromAsync`, no regex `v` flag — none of which reached Safari until 17.4; generators and `async`/`await` are the newest things in it |
| The bundled typeface | a variable WOFF2, supported since Safari 11 |

Things the audit changed:

* **`PrivacyInfo.xcprivacy`** now ships in the app. It declares no tracking, no tracking
  domains, no collected data and no required-reason API use — which is the truth, and
  what App Review has expected of new submissions since 2024.
* **Object ids in `project.pbxproj`.** Two objects once shared one. `npm run test:ios`
  now reads the project file and fails if it ever happens again.
* **The last outbound request is gone.** The typeface used to come from Google Fonts.
  It is now in `fonts/`, the page carries a `Content-Security-Policy` that allows no
  http(s) source, and `WebAppView` compiles a `WKContentRuleList` that blocks any such
  load inside the web view. The app makes no network requests at all.

`SWIFT_VERSION` is 5.0, so building with Xcode 16 does not drag the code into Swift 6's
strict concurrency checking. Note that App Store Connect has required builds made with
the iOS 18 SDK (Xcode 16) since spring 2025; nothing here pins an SDK, so a newer Xcode
is fine.

**What no test here can prove:** the harness is Chromium, because no WebKit build ships
in this environment. The cube is drawn with CSS 3D transforms, which WebKit renders on
its own terms, so run the app once in the iOS 17 Simulator (and on a device if you
have one) before you ship.

## Tested on

Drawing is tuned for a device: a 6×6 turn holds 36-40 fps with the CPU throttled to a
quarter, where it used to manage 16, and a 3×3 move takes exactly as long as the speed
you picked rather than 40% longer.

`npm run test:ios` reads the Xcode project and then drives the very bundle the build
phase produces, on an iPhone 12 and an iPad Pro 11 profile, by touch: 63 checks,
including a whole 4×4 solved by tapping and a check that no control is smaller
than 44pt. Layout was checked at
iPhone SE, iPhone 15 Pro (portrait and landscape), iPad mini, iPad Pro 12.9, and the
narrow iPad Split View and Slide Over widths, since the app allows multitasking.
The one thing no test here can prove is WebKit itself: run it once in the Simulator.
