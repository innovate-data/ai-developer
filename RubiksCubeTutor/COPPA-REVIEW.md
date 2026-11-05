# COPPA Review: Cube Clubhouse®

Version 1.0 · reviewed 5 November 2026 · repeat every year, and whenever anything under
"What would change the answer" happens.

This is an **engineering review** of the app's code and behaviour against the Children's
Online Privacy Protection Rule (COPPA, 16 CFR Part 312), as amended in 2025, with
compliance required from 22 April 2026. **It is not legal advice.** Have a lawyer who
knows COPPA review it, together with the Privacy page and `LICENSE`, before release.

It is also Ira Learning LLC's **written information security program** (§ 312.8) and
**written data retention policy** (§ 312.10). The app shows the same review on its COPPA
Review page; both that page and the hosted `ios/app-store/coppa.html` are drawn from
`js/coppa.js`, and a unit test checks that the table below agrees with it.

## Does COPPA apply?

**Yes, and we act as if it does for everyone.** COPPA applies to a website or online
service directed to children under 13, or one that knows it collects from them.

- *Directed to children:* Cube Clubhouse is worded for a general audience of all ages,
  but the FTC looks at the whole service (subject, pictures, language, actual audience).
  A puzzle cube, stars, a 🧠 badge and words written so a seven-year-old can read them
  appeal to children, and children use it. We treat it as directed to children.
- *Online service:* the web page itself makes no request at all, but the iPhone and iPad
  app reaches the internet for its App Store update check, and it is distributed online.

The approach is **comply by collecting nothing**: no accounts, no analytics, no ads, no
boxes to type words into, no links a child can follow, and progress kept only on the
device. Then there is no personal information, so no notice to parents and no consent is
needed. The only network traffic is the App Store update check, and the App Store sheet
that a grown-up opens after answering a question.

## Requirement by requirement

| Requirement | Rule | Status | How Cube Clubhouse meets it |
|---|---|---|---|
| No personal information is collected | § 312.2, § 312.3 | Meets | No accounts, sign-in, forms, chat or text boxes. Stars, times and settings stay in `localStorage` and `UserDefaults` on the device; nothing is sent. The grown-up gate's keypad keeps nothing. |
| Persistent identifiers only for internal operations | § 312.2 (support for the internal operations), § 312.5(c)(7) | Meets | The app creates and reads no identifier (no IDFA, no `identifierForVendor`, no cookies). The update check sends only `bundleId` and `country`; Apple sees the network's IP address, as with any request. It exists only to keep the app working and updated, and can be switched off. We never receive it. |
| No third party collects through the app | § 312.2 (operator, third party) | Meets | No third-party code, SDK, ad network, analytics or crash reporter. Apple, the platform, is the only other party reached. |
| Separate consent before sharing with third parties | § 312.5(a)(2) | Not needed | Nothing is collected, so nothing is disclosed. |
| Online notice, linked prominently | § 312.4(d) | Meets | Privacy page one tap from every screen (footer), and hosted as `privacy-policy.html` for the App Store listing. Names the operator and contact, lists everything kept, retention, and parents' rights. |
| Direct notice to parents and their consent | § 312.4(b)–(c), § 312.5 | Not needed | Required only when a child's information is collected. None is. |
| Replying once to a child who writes | § 312.5(c)(3) | Meets | No email link in the app; children are asked to have a grown-up write. A child who writes anyway gets one reply (asking a grown-up to write), and the message and address are deleted within 7 days and never added to a list. |
| Parents can review and delete | § 312.6 | Meets | We hold nothing about any child. On the device: Clear Saved Progress, or delete the app. A grown-up's email is deleted on request. |
| Nothing asked in order to take part | § 312.7 | Meets | Every feature works without giving any information. |
| A security program | § 312.8 | Meets | No children's data held. Mailbox protected with a strong password and two-step verification; only Ira Learning LLC reads it. This file is the written program. `npm run preflight` blocks any change that would collect, send, link out or track. |
| A written retention policy, published | § 312.10 | Meets | "How long we keep information" on the Privacy page: device data until cleared or the app is deleted; a grown-up's email no later than 12 months after the last message; a child's email no later than 7 days after it arrives. |
| A mixed audience | § 312.2 (directed to children) | Meets | No age question. Everyone is treated as possibly a child, which is stricter than the rule and needs no age screen. |
| No links out, and the shop behind a grown-up | Good practice; Apple App Review Guidelines 1.3 and 5.1.4 | Meets | No links leave the app; `WebAppView` refuses any navigation off the bundle instead of opening Safari. The App Store sheet opens only through `GrownUpGate` (a times-table answer on a keypad). |
| A safe harbor program | § 312.11 | Optional | Voluntary. Not needed for an app that collects nothing; an option if outside certification is wanted. |

## Technical evidence

Read at this commit. There are **no third-party packages, plug-ins, pods or Swift
packages**: `package.json` has no dependencies, and the Xcode project has no package
references. Every component is listed here.

**The web app** (`index.html`, `css/`, `js/`), which runs inside `WKWebView`:

- Content-Security-Policy: `default-src 'none'`, `connect-src 'none'`; scripts, styles,
  fonts, images and media only from the app itself (`'self' cubeclubhouse: file:`). So
  `fetch`, XHR, beacons and sockets are refused by WebKit even if code tried.
- No network APIs, cookies, fingerprinting APIs, sensors, `<input>` that takes words,
  `<textarea>`, `contenteditable`, `prompt()` or external links (checked by preflight).
- Storage: four `localStorage` keys (lesson stars and 🧠 badges, Play size, guide speed,
  Timer times with size and penalty, no dates). Listed on the Privacy page; a unit test
  fails if a new key appears.
- Speech: the Read buttons use the system voice (`speechSynthesis`), which on iPhone and
  iPad runs on the device.
- Video: the tour (`media/intro.mp4`) ships inside the app and plays from it.

**The iOS shell** (`ios/CubeClubhouse/`, Swift; frameworks: SwiftUI, WebKit, StoreKit,
UIKit, Foundation, all Apple's):

| File | Network | Identifiers | Notes |
|---|---|---|---|
| `CubeClubhouseApp.swift` | none | none | Launch cover; the update alert and the grown-up gate sheet. |
| `WebAppView.swift` | none; a `WKContentRuleList` blocks every `^https?://` load | none | Refuses any navigation off the bundle (no Safari hand-off). Haptics and the Updates switch via message handlers. |
| `BundleSchemeHandler.swift` | none; serves files from the bundle over `cubeclubhouse://` | none | Byte ranges for the video. |
| `UpdateChecker.swift` | one `GET https://itunes.apple.com/lookup?bundleId=…&country=…`, ephemeral session, no cookies, no cache, at most daily, switchable | none | Keeps three settings in `UserDefaults`. Opens `SKStoreProductViewController` only from `passGate()`. |
| `GrownUpGate.swift` | none | none | Keypad only; nothing kept. |

`PrivacyInfo.xcprivacy`: no tracking, no tracking domains, no collected data types;
UserDefaults declared with reason CA92.1 (read by this app only). No `NS…UsageDescription`
permission is requested; no `AdSupport` or `AppTrackingTransparency`.

**Apple as a first party.** The update check and the App Store sheet are Apple's own
services. Apple receives the device's network address and, inside the store sheet, whatever
the App Store itself handles; that is governed by Apple's privacy policy, and we never
receive any of it.

**Android.** There is no Android version, so no Google Play Billing and no Play services.
If one is ever made, see "Android" in `ios/app-store/APP-STORE.md` before release: Google
Play Billing sends Google its own diagnostics, which is a first-party Google collection to
disclose, and the `AD_ID` permission must be removed.

## What we do, as the publisher

These are commitments outside the code. The Privacy page promises them.

- Keep the support mailbox, support@iralearningllc.com, working, and check it at least weekly.
- Protect it with a strong, unique password and two-step verification. Review who has
  access once a year; today only Ira Learning LLC.
- Answer a child once, asking a grown-up to write, and delete the child's message and
  address within 7 days.
- Delete a grown-up's messages once we have finished helping, and no later than 12 months
  after the last one; sooner on request. Check the mailbox against this schedule monthly.
- Never add anyone's address, least of all a child's, to a mailing list or any other list.
- Keep this file as the written security and retention program, and repeat the review
  every year and before any release that changes what the app does.
- Optional: publish a mailing address and phone number for privacy questions.

## What would change the answer

Any of these needs this review done again before it ships, and most would need verifiable
parental consent, a direct notice, or both. The preflight guard fails the build on most of
them.

- Accounts, sign-in, or saving progress anywhere but the device (including iCloud sync)
- Analytics, crash reporting or any usage measurement
- Advertising of any kind
- Links out of the app, or any way to share
- The camera, the microphone, location or contacts
- Chat, messages, or any box for typing words
- Any new software kit, library, plug-in or package

## How to repeat this review

1. `npm run preflight`: must pass.
2. Read every Swift file and every new file in `js/`; update the evidence table above.
3. Run the app with a network monitor and confirm the only request is the App Store lookup
   (and nothing at all with the update check switched off).
4. Re-check the rule for amendments since the last review.
5. Update the date here and in `js/coppa.js`, run `npm run build:store-pages`, and re-host
   `coppa.html` and `privacy-policy.html`.
