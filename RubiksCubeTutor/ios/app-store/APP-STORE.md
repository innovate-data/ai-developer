# Releasing Cube Clubhouse® on the App Store

Everything App Store Connect asks for, ready to paste, and the steps in order. The app
itself is ready: `ios/release.sh` archives it, checks it, and exports or uploads it.

## What you need first

- A Mac with the **current Xcode** from the Mac App Store. Apple only accepts uploads
  built with a recent Xcode and iOS SDK; the project itself opens in Xcode 15 or newer.
- A paid **Apple Developer Program** membership (US$99 a year) for Ira Learning LLC.
  Enrol as an organisation so the store shows "Ira Learning LLC" as the seller; that
  needs a D-U-N-S number for the company.
- Your **Team ID**: developer.apple.com › Account › Membership details.

## 1. Register the app

1. developer.apple.com › Certificates, IDs & Profiles › Identifiers › **+** › App IDs ›
   App. Bundle ID (explicit): `com.iralearningllc.cubeclubhouse`. No capabilities needed.
   (If you want a different identifier, change `PRODUCT_BUNDLE_IDENTIFIER` in the
   target's build settings, or pass `BUNDLE_ID=` to `release.sh`.)
2. appstoreconnect.apple.com › Apps › **+** › New App: platform iOS, name
   **Cube Clubhouse**, primary language English (U.S. or U.K.), that bundle ID, SKU
   `cubeclubhouse-ios`, full access.

## 2. Host the two web pages

App Store Connect needs a **Privacy Policy URL** and a **Support URL**. Both pages are
already written, in this folder:

- `privacy-policy.html`: the app's own Privacy section, word for word.
- `support.html`: contact address and common questions.

Put both on any web host (GitHub Pages, Netlify, Google Sites, your own domain) at
addresses like `https://example.com/cubeclubhouse/privacy-policy.html`. They load nothing
from anywhere else. If you change the Privacy section in `index.html`, run
`npm run build:store-pages` and upload them again; the unit tests fail until you do.

## 3. Build and upload

```sh
cd RubiksCubeTutor
TEAM_ID=ABCDE12345 ios/release.sh --upload
```

This runs the unit tests, archives a Release build for any iOS device, checks that the
web app, the privacy manifest, the bundle ID and the export-compliance key are inside,
and uploads it. Without `--upload` it writes a signed `.ipa` to `ios/build/export/`
instead, for the Transporter app. `ios/release.sh --help` lists the options (version,
build number, and an App Store Connect API key for machines without Xcode's account).

Prefer the Xcode window? Choose **Any iOS Device** as the destination, then
**Product › Archive**, then **Distribute App › App Store Connect**.

The build shows under **TestFlight** after Apple processes it (usually 5 to 30 minutes).
Install it on a real iPhone and iPad through TestFlight before you submit.

## 4. The store listing

**Name** (30 max): `Cube Clubhouse`

**Subtitle** (30 max): `Learn to solve the Cube`

**Category**: Primary **Education**; secondary **Games › Puzzle** (optional).
Do **not** choose the Kids Category: the app is for a general audience of all ages.

**Promotional text** (170 max):

> Ten short lessons take you from your first turn to your first solve. Free, no account,
> no adverts, and it works without the internet.

**Description** (4,000 max):

> Cube Clubhouse helps anyone, of any age, learn to solve a Cube step by step, using the
> beginner layer-by-layer method most people learn first.
>
> LEARN
> Ten short lessons, in order, from what the pieces are called to the last twist. Each
> lesson has a 3D cube you can turn, the trick written in plain words, and a practice
> puzzle that checks your work and gives up to three stars.
>
> PLAY
> A free-play cube from 2×2 up to 6×6, with mix-up and undo. Stuck? Help Me Solve It walks
> the cube on the screen back to solved, one step at a time, at the speed you choose.
>
> MY REAL CUBE
> Paint in the colours of the cube in your hand, and the app works out steps to solve it.
>
> TIMER
> Already solving? A speedcubing timer: a mix to copy (tick each turn off as you go),
> optional 15-second inspection, +2 and DNF, your best time and best averages of 5 and 12
> for each size, and a chart of your progress.
>
> MADE TO BE CALM AND PRIVATE
> • Free: no purchases, no subscriptions, no adverts
> • No account, no sign-in, nothing to type
> • Collects no data at all, and works fully offline
> • Read aloud button for every step
> • Follows Dark Mode, Text Size and Reduce Motion
> • Every colour is also named in words
>
> A cube is not included. Real puzzle cubes contain small parts and are not suitable
> for children under three.
>
> Cube Clubhouse is an independent app. It is not made by, affiliated with or endorsed by
> the owner of any puzzle-cube trademark.

**Keywords** (100 max, commas, no spaces):
`puzzle,solve,solver,speedcubing,timer,beginner,learn,tutor,lessons,3x3,2x2,4x4,5x5,6x6,layer`

Do not put other companies' trademarks (for example Rubik's) in the name, subtitle or
keywords: Apple rejects that.

**Support URL**: your hosted `support.html`.
**Marketing URL**: optional; leave empty.
**Copyright**: `2026 Ira Learning LLC`

**Screenshots** (in `screenshots/`, already at the sizes Apple asks for):

| Device size in App Store Connect | Files |
|---|---|
| iPhone 6.9" Display | `iPhone-6.9-1-learn.png` … `iPhone-6.9-5-my-real-cube.png` (1320 × 2868) |
| iPad 13" Display | `iPad-13-1-learn.png` … `iPad-13-5-my-real-cube.png` (2064 × 2752) |

App Store Connect scales these for every smaller device. Upload them in the numbered
order. `npm run build:screenshots` draws them again after the app changes.

**App icon**: comes from the build; nothing to upload.

## Promo video

`promo/promo.mp4` is a 20-second advert: 1080 × 1920 portrait, 30 fps, H.264 with AAC
stereo, about 4 MB, sound at −15 LUFS. That is the shape Instagram Reels, TikTok and
YouTube Shorts want, and it plays on a website as it is. `promo/promo-poster.png` is its
last frame, for a thumbnail.

| Time | On screen |
|---|---|
| 0–2 s | The icon and name: "Learn to solve the Cube, one step at a time." |
| 2–5.6 s | "Ten short lessons": the lesson list, then a lesson's cube turning |
| 5.6–9.8 s | "Stuck? Help Me Solve It": a cube mixes itself, then solves itself |
| 9.8–12.6 s | "Paint in your cube": the flat cube fills with colours and is checked |
| 12.6–16.5 s | "Time it. Beat your best.": mix turns ticked off, then the clock running |
| 16.8–20 s | End card: Free · No ads · No account · Works offline · For iPhone and iPad · All ages |

Everything in the phone is the real app, filmed running. The music is made from sine
waves and noise in `promo/music.js`, so there is nothing to license. The advert makes
no promise about results, names no other company's product, and says the cube is not
included.

It is not an App Store **App Preview**: those must show only the app's own screen, with
no device frame, at Apple's preview sizes. Use it for social posts and your website.

To make it again after the app changes: `npm i --no-save playwright-core`, then
`FFMPEG=/path/to/ffmpeg npm run build:promo`. It needs Chrome or Chromium and ffmpeg
with libx264. The stage is `promo/promo.html`; the timeline is in `promo/record.js`.

## 5. App Privacy

- Privacy Policy URL: your hosted `privacy-policy.html`.
- "Do you or your third-party partners collect data from this app?" **No, we do not
  collect data from this app.** The result is **Data Not Collected**.

This is accurate. Data that stays on the device (stars, times) does not count as
collection. The one request the app makes, the optional update check, asks Apple's App
Store whether a newer version exists and carries only the app's bundle ID and the
country; nothing about the person is sent, and nothing reaches you or any partner. The
bundled `PrivacyInfo.xcprivacy` says the same, and declares UserDefaults (reason CA92.1)
for the check's own settings.

## 6. Age rating

Answer every content question **None** / **No**: no violence, no mature themes, no
gambling, no contests, no user-generated content, no messaging or chat, no unrestricted
web access, no advertising, no in-app purchases, no medical or wellness content, no
parental controls or age assurance built in. The result is **4+**, which means "suitable
for everyone", not "made for children". Leave **Made for Kids** off.

## 7. Everything else on the version page

- **Content Rights**: "Does your app contain, show, or access third-party content?"
  **No.** (The typeface is licensed to you under the SIL Open Font Licence and ships
  with its licence.)
- **Export compliance**: already answered in the build (`ITSAppUsesNonExemptEncryption
  = NO`); App Store Connect will not ask.
- **Pricing and Availability**: Free, all countries or the ones you choose.
- **Sign-in required**: No.
- **App Review contact**: your name, phone and `iralearningllc@gmail.com`.
- **Notes for App Review**:

> Cube Clubhouse teaches how to solve a puzzle cube. No account or sign-in is needed. The
> only network request is an optional App Store version check (About › Updates, which
> can switch it off). To try the main features: Learn › any lesson ›
> Hint; Play › Mix It Up › Help Me Solve It › Watch; My Real Cube › Try a Pretend Cube ›
> Check My Cube; Timer › touch and hold the clock, let go to start, tap to stop. The
> About, Privacy and Licence pages are linked at the bottom of every screen.

- **Version release**: Manually release this version (so you choose the day).

Then **Add for Review** › **Submit to App Review**. Review usually takes a day or two.

## Later versions

Bump the version (`VERSION=1.0.1 TEAM_ID=… ios/release.sh --upload`). The build number
is raised for you on upload. Update the "This version of Cube Clubhouse (1.0)" line and
the "Last updated" dates on the Privacy and Licence pages if what the app does changes,
then rebuild the hosted pages.

## Before the first release, with a lawyer

The licence and privacy wording were written to reduce risk, not reviewed by a lawyer.
Have one confirm: the state named for governing law, whether to add arbitration, whether
to publish a postal address, the US$10 liability cap, and the Apple terms in clause 12.
Use ® only while the mark is actually registered; otherwise ™.
