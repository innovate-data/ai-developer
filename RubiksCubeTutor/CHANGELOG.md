# Changelog

All notable changes to Cube Clubhouse®. Dates are when the change was made.

## 5 November 2026

### Added
- **COPPA Review.** `COPPA-REVIEW.md` reviews the app requirement by requirement against
  the COPPA Rule as amended in 2025, with the technical evidence, the publisher's duties,
  and what would change the answer. The same review is a page in the app (About › COPPA
  Review, and COPPA in the footer) and a hosted page, `ios/app-store/coppa.html`, both
  drawn from `js/coppa.js`. An engineering review, not legal advice.
- **Build guard.** `npm run preflight` (also run by `npm test` and `ios/release.sh`) fails
  the build on network requests, boxes for typing words, links out, the camera,
  microphone, location or contacts, cookies or fingerprinting, analytics or advertising
  kits, unreviewed dependencies, or a missing COPPA Review. A negative-control test plants
  each kind of problem and checks it is caught.
- **Grown-up gate.** The App Store sheet behind "Update" now opens only after a grown-up
  answers a times-table question on a keypad.

### Changed
- **Contact address** is now support@iralearningllc.com everywhere: the Privacy, Licence
  and COPPA Review pages, `LICENSE`, the hosted pages and the App Store guide.
- **Privacy page.** New sections "If you write to us" (mailbox protected with a strong
  password and two-step verification; a child gets one reply and is deleted within 7 days)
  and "How long we keep information"; Children's privacy links to the COPPA Review.
- **No links out.** The iOS app refuses any navigation off the bundle instead of handing
  links to Safari.
- **The tour video** moved from the About page to the top of the Learn screen. It hides
  when a lesson opens and pauses when Learn is left.

## Earlier in 2026

- The 20-second tour video, also used as a promo, with its recorder and music (September).
- App Store update check with a switch and Check Now; hosted privacy and support pages;
  App Store release script, kit and screenshots; Reset Cube in lessons (September).
- Wording for a general audience of all ages; licence terms, safety and supervision; a
  liability cap; a contact address (September).
- iOS app for iPhone and iPad (iOS 17): launch screen, iOS wording and controls, haptics,
  Text Size, offline font, no network requests from the page.
- Speedcubing timer with best times, averages and a chart; Help Me Solve This Mix.
- The lessons, Play on 2×2 to 6×6, My Real Cube and the guided solver.
