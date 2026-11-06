# Changelog

All notable changes to Cube Clubhouse®. Dates are when the change was made.

## 6 November 2026

### Added
- **Magnet warning.** The licence (clause 8), About › Safety and the App Store description now
  say that many speed cubes contain small, strong magnets, to keep a broken cube away from
  children, and to get medical help at once if a magnet may have been swallowed.
- **Under 13s.** The licence asks that anyone under 13 uses the app with a parent's or
  guardian's permission. The app stays rated 4+ for all ages; the App Store guide says why.
- **My Real Cube care note:** "Turn your cube gently. If a piece pops out, keep it away from
  young children."

### Changed
- **Ages 6 and over.** "For any age" / "all ages" is now "aged 6 and over" (or "ages 6+")
  everywhere: the licence, About, Privacy, the COPPA Review, the footer, the tour, the hosted
  pages, the App Store description, the promo end card and the README. There is still no
  upper age limit, and the App Store rating stays 4+.

### Fixed
- **No flicker with Reduce Motion.** With Reduce Motion on, a turn is a cut instead of an
  animation, and a fast solve or Mix It Up cut up to 16 times a second (over the
  three-flashes-a-second limit in WCAG 2.3.1). Each move now holds 400 ms before the next.

## 5 November 2026

### Changed
- **Liability cap** in the licence (clause 10) is now one US cent (US$0.01), because the app is free.

### Fixed (an iPad review)
- **The tour no longer pushes the lessons off a landscape iPad's first screen.** On a wide
  window it is a card, the video on the left and its words beside it.
- **No more two-row sticky header.** An iPad mini upright, Split View and Stage Manager windows
  (621 to 779 px wide) got a 123 px pinned bar with the tabs stranded on a second row. Up to 779
  px the tabs are now the bottom tab bar, and above it the capsule stays at the top in one row.
  Scrolling to the guide, or tabbing with a keyboard, no longer parks a control under that bar.
- **Slide Over at the largest Text Size (256 px) is usable.** The cube column grew to 280 px and the
  tab bar to 288, so text and buttons were cut off at the right and the fourth tab was lost. Columns
  now shrink, the size selector wraps, and long words and addresses break.
- **A cube column taller than the window scrolls instead of sticking.** Pinned, its lower controls
  (the rest of the move pad, the timer) could not be reached until the page ended. A lesson's column
  now fits an iPad mini in landscape, and My Real Cube or a 6×6 scrolls; it follows the iPad as it turns.
- The ® is never smaller than 10 px (it was 7 px in the footer).

### Added
- **Loading page.** The app now opens on a loading page drawn by CSS alone: the launch
  screen's logo at its size and in its place, stickers rippling (still with Reduce
  Motion), and "Getting your cube ready…". It fades away once every screen is built, says
  so if starting fails, and after 8 seconds without the app's script asks you to close
  and reopen the app. Screen readers hear it as a status, and the page behind is marked
  busy until it is ready.
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
