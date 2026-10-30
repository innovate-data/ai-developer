# N-400 Interview Trainer

A single-file web app for practicing the U.S. naturalization (Form N-400) interview.
Open `index.html` in any browser. No install or server needed; progress is saved in the browser.

## What it covers

- **Civics study**: flashcards for the 100 civics questions, filtered by topic. Missed questions come back sooner; a question counts as learned after 3 correct answers in a row.
- **Mock civics test**: the officer's questions are read aloud. Follows the stop rules of the test you take:
  - 2025 test (N-400 filed on or after Oct 20, 2025): up to 20 questions, 12 correct to pass, ends at 9 incorrect.
  - 2008 test (filed before Oct 20, 2025): up to 10 questions, 6 correct to pass, ends at 5 incorrect.
- **Reading and writing**: practice sentences built from the official USCIS reading and writing vocabulary. Writing is dictated by speech and checked word by word.
- **N-400 words**: practice questions the officer asks about your application, plain-English definitions of hard words on the form (genocide, habitual drunkard, noncombatant service, and so on), and the Oath of Allegiance.
- **My answers**: your state, senators, representative and governor, used for the location-based civics questions.

## Keep it current

- Answers about current officials (President, Vice President, Speaker of the House) are as of October 2026. Edit the `RAW` array in `index.html` after elections.
- The question bank is the 2008 100-question list. The 2025 test uses a 128-question list on the same topics; review it at
  https://www.uscis.gov/citizenship/find-study-materials-and-resources/study-for-the-test before the interview.
