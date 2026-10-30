# N-400 Interview Trainer

A single-file web app for practicing the U.S. naturalization (Form N-400) interview.
Open `index.html` in any browser. No install or server needed; progress is saved in the browser.

## What it covers

- **Civics study**: flashcards for both official civics question lists, filtered by topic: the 2025 list (128 questions, USCIS form M-1778) and the 2008 list (100 questions). The app uses the list that matches your test version. Missed questions come back sooner; a question counts as learned after 3 correct answers in a row.
- **Mock civics test**: the officer's questions are read aloud. Follows the stop rules of the test you take:
  - 2025 test (N-400 filed on or after Oct 20, 2025): up to 20 questions, 12 correct to pass, ends at 9 incorrect.
  - 2008 test (filed before Oct 20, 2025): up to 10 questions, 6 correct to pass, ends at 5 incorrect.
- **Reading and writing**: practice sentences built from the official USCIS reading and writing vocabulary. Writing is dictated by speech and checked word by word.
- **N-400 words**: practice questions the officer asks about your application, plain-English definitions of hard words on the form (genocide, habitual drunkard, noncombatant service, and so on), and the Oath of Allegiance.
- **My answers**: your state, senators, representative and governor, used for the location-based civics questions.

## Keep it current

- Answers about current officials (President, Vice President, Speaker of the House, Chief Justice) are as of October 2026. Edit the `RAW25` and `RAW08` arrays in `index.html` after elections, and check https://www.uscis.gov/citizenship/testupdates.
- The 2025 list was entered without access to the USCIS PDF. Compare it with the official list at
  https://www.uscis.gov/citizenship/find-study-materials-and-resources/study-for-the-test
