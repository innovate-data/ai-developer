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
| `ios/CubeClubhouse/*.swift` | Three files: the app (with its launch cover), the web view host, the bundle server |
| `ios/CubeClubhouse/Info.plist` | Only the launch screen; Xcode generates every other key from build settings |
| `ios/CubeClubhouse/Assets.xcassets` | App icon (1024×1024, no alpha), accent colour, and the launch screen's logo and background |
| `ios/launch-art/` | The launch logo's source and `render.js`, which redraws it (`npm run build:launch`) |
| `index.html`, `css/`, `js/`, `fonts/` | The app itself: lessons, solver, timer, cube models, 3D view |
| `tests/` | Test suites, not part of the app bundle |

The app is the web app in the parent folder, hosted in a `WKWebView`. A build phase
named **Copy web app into bundle** copies `index.html`, `css/` and `js/` into the app
bundle every time you build, so there is only one copy of the code and editing the
web app then pressing Run is enough.

**Keep this folder structure.** The copy phase reads from the folder above `ios/`.
If you move `CubeClubhouse.xcodeproj` somewhere else on its own, the build stops with
a message telling you so.

## Feels like iOS

The app speaks and behaves like an iOS app: tap and touch and hold, Title Case buttons,
a bottom tab bar on iPhone and a top capsule on iPad, segmented controls, a switch, iOS
alerts before anything is lost, haptics on iPhone, and it follows the device's Text Size.
`WebAppView.swift` does the native half: it tells the page it is the iOS app and on which
device (so the page says "this iPad", not "this browser"), plays haptics when the page
asks through the `haptic` message handler, and sets `pageZoom` from the Text Size
setting (up to 125%). See "Speaking and feeling like iOS" in the main README.

## The launch screen

While the app starts, iOS shows the Cube Clubhouse® logo (the cube face from the icon,
with the name) centred on the app's own background colour, in light or dark to match the
device. It comes from `UILaunchScreen` in `Info.plist`: the `LaunchBackground` colour and
the `LaunchLogo` image set in the asset catalog. The colour is exactly the page's
background, and `RootView` keeps the same picture on screen until the page has loaded,
then fades it out (instantly if Reduce Motion is on), so there is no white flash between
the launch screen and the first lesson list. If the page ever fails to load, the cover
still lifts after four seconds.

To change the logo, edit `ios/launch-art/logo.html` and run `npm run build:launch`
(it needs `playwright-core`, like the browser tests); `npm run test:ios` checks the
result fits every iPhone and matches the background.

If the launch screen does not update on a device, delete the app and run again: iOS
caches launch screens per install.

## Changing the app's name

The name under the icon comes from `INFOPLIST_KEY_CFBundleDisplayName` in the target's
build settings. Change it there; you do not need to rename files or the scheme.

The name under the icon is "Cube Clubhouse" without the ® sign on purpose: the home
screen has room for about twelve characters, and the sign would get it cut short. The ®
appears in the app itself: in the header on every screen, on the launch screen, in the
footer, and in the licence and trademark notice. Use ® only while the mark is actually
registered; a mark that is claimed but not registered takes ™ instead.

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
  written — it is the Privacy section of the in-app **For Grown-Ups** page (the footer
  links lead there) — so put the same text on a page of your own and link to that. Use
  the browser wording there, since it will be read in a browser.
* **Who to contact.** The Privacy page names Ira Learning LLC and gives
  irealearningllc@gmail.com; the licence page and `LICENSE` give it too. It is plain text,
  not a mail link, on purpose: a link that leaves a Kids Category app must sit behind a
  parental gate. Use the same address as the support and privacy contact in App Store
  Connect.

The app is free with no purchases, no subscriptions and no advertising, so there is
nothing to declare under in-app purchases and nothing to price. If you publish in the
Kids category, note that it also has no external links, so no parental gate is needed.

## Known scope

Every part of the app is free to use, with nothing held back and nothing to buy.
The **Timer** tab is a speedcubing timer for the child's real cube: hold the pad until it
turns green, let go to start, tap anywhere to stop. It works with an iPad keyboard's space
bar too. The mix can be ticked off turn by turn, "Help me solve this mix" gives guided steps
for it on any size, and a chart shows the last 50 times. Its times stay on the device, which App Privacy does not count as collection:
"Data Not Collected" still holds.
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
