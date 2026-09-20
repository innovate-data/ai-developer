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
| `ios/CubeClubhouse/*.swift` | Four files: the app, the web view host, the bundle server, the shop |
| `ios/Products.storekit` | A local shop, so the purchase works in the Simulator with no account |
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

## The in-app purchase

Step-by-step help on a 3×3 and bigger is a one-off purchase; the 2×2 walkthrough and
everything else stays free. Apple requires this kind of unlock to go through in-app
purchase, so it is StoreKit, not a card form.

**It already runs in the Simulator.** `ios/Products.storekit` describes the product and
the shared scheme points at it, so Product → Run gives you a working shop with no
account: buy it, and Debug → StoreKit → Manage Transactions lets you refund it and watch
the app lock again.

**Before it works on a real device or in TestFlight**, create the product in App Store
Connect:

1. My Apps → your app → **Monetization → In-App Purchases** → **+**
2. Type **Non-Consumable**, reference name *Step-by-step help*, product ID
   **`com.iralearning.cubeclubhouse.solver`** — it must match `StoreManager.productID`
   and `js/store.js` exactly.
3. Price: **Tier 1** ($0.99 in the US; App Store Connect fills in the other currencies).
   The app never hard-codes the price on a device — it shows `Product.displayPrice`, so
   every country sees its own.
4. Fill in a display name, a description and a review screenshot, then attach the
   purchase to your first submission.
5. Family Sharing is switched on in the test configuration; leave it on in App Store
   Connect if you want one purchase to cover a family.

**In the review notes**, say where the purchase lives (Play → a 3×3 or bigger → *Help me
solve it*), that a grown-up check stands in front of it, and that *I already bought it*
restores it. Reviewers look for a restore button on a non-consumable and for the
parental gate in a children's app.

To change the price, change it in App Store Connect — nothing in the code needs
touching. To change what is free, `FREE_SIZE` in `js/store.js` is the only line.

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

If you publish in the Kids category, note that the app has no external links, no
purchases and no advertising, so no parental gate is needed.

## Known scope

Every size from 2×2 to 6×6 has a guided solve on the Play screen. The 4×4, 5×5 and
6×6 use the reduction method (centres, then edge pairing, then the 3×3 method), so a
6×6 solve is long, around 95 cards. Working one out is real arithmetic: about a
second on a recent iPad and up to six on an older iPhone, so the app does it a slice
at a time, says what it is doing ("Thinking… joining the edges") and holds the Play
controls until it is ready, rather than freezing. The tables it builds are kept for
the size in play only, about 30 MB at the largest. The Learn lessons and "My real
cube" are 3×3.

## Tested on

Drawing is tuned for a device: a 6×6 turn holds 36-40 fps with the CPU throttled to a
quarter, where it used to manage 16, and a 3×3 move takes exactly as long as the speed
you picked rather than 40% longer.

`npm run test:ios` drives the very bundle the build phase produces, on an iPhone 12
and an iPad Pro 11 profile, by touch: 43 checks, including a whole 4×4 solved by
tapping and a check that no control is smaller than 44pt. Layout was checked at
iPhone SE, iPhone 15 Pro (portrait and landscape), iPad mini, iPad Pro 12.9, and the
narrow iPad Split View and Slide Over widths, since the app allows multitasking.
The one thing no test here can prove is WebKit itself: run it once in the Simulator.
