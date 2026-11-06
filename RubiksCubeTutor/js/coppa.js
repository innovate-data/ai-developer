/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * coppa.js - the COPPA Facts page, as data, and the one function that draws it.
 *
 * The app's COPPA Facts page (About > COPPA Facts, or COPPA in the footer) and the hosted
 * ios/app-store/coppa.html are both drawn by toHTML() from the data below, so the two
 * cannot say different things. The page states plain facts about what the app does; it
 * gives no verdicts. COPPA-REVIEW.md is the internal written review, with the rules and
 * statuses kept here as `rule` and `status`; a unit test checks the two agree.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.RC = root.RC || {}; root.RC.COPPA = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUS = {
    meets: 'Meets',
    'not-needed': 'Not needed',
    optional: 'Optional',
  };

  const review = {
    reviewed: '6 November 2026',
    appVersion: '1.0',
    rule: 'the Children’s Online Privacy Protection Rule (16 CFR Part 312), as amended in 2025, with compliance required from 22 April 2026',

    audience: 'Cube Clubhouse is made for anyone aged 6 and over, and children use it. So it is built as '
      + 'if every person who opens it might be a child: it collects nothing from anyone, and it makes no '
      + 'internet request at all.',

    // fact and text are shown; heading, rule and status are the internal review's (COPPA-REVIEW.md)
    checks: [
      {
        fact: 'Nothing is collected',
        heading: 'No personal information is collected', rule: '§ 312.2, § 312.3', status: 'meets',
        text: 'There are no accounts, sign-ins, forms, chat or boxes to type words into. Stars, times and '
          + 'settings stay on the device and are never sent to us or anyone else.',
      },
      {
        fact: 'No identifiers, and no internet requests',
        heading: 'Persistent identifiers only for internal operations', rule: '§ 312.2 (support for the internal operations), § 312.5(c)(7)', status: 'meets',
        text: 'The app makes and reads no identifier: no advertising identifier, no vendor identifier, no '
          + 'device ID, no cookies. It makes no internet request of any kind, not even to look for a new '
          + 'version; new versions come through the App Store.',
      },
      {
        fact: 'No third-party code',
        heading: 'No third party collects through the app', rule: '§ 312.2 (operator, third party)', status: 'meets',
        text: 'There is no advertising, analytics, crash reporting, social buttons or software kits. The app '
          + 'sends nothing to anyone, Apple included.',
      },
      {
        fact: 'Nothing shared',
        heading: 'Separate consent before sharing with third parties', rule: '§ 312.5(a)(2)', status: 'not-needed',
        text: 'Nothing is collected, so nothing is shared, sold or disclosed to anyone.',
      },
      {
        fact: 'A privacy page one tap away',
        heading: 'Online notice, linked prominently', rule: '§ 312.4(d)', status: 'meets',
        text: 'The Privacy page is one tap from every screen (Privacy, at the bottom) and is published '
          + 'in the same words for the App Store listing. It names us and how to reach us, lists '
          + 'everything the app keeps and where, says how long anything is kept, and explains a '
          + 'parent’s choices.',
      },
      {
        fact: 'No notice to send, no consent to ask for',
        heading: 'Direct notice to parents and their consent', rule: '§ 312.4(b)–(c), § 312.5', status: 'not-needed',
        text: 'Because no child’s information is collected, the app sends no notice to parents and asks for '
          + 'no consent.',
      },
      {
        fact: 'If a child writes to us',
        heading: 'Replying once to a child who writes', rule: '§ 312.5(c)(3)', status: 'meets',
        text: 'The app has no email link, and asks children to have a grown-up write for them. If a child '
          + 'writes anyway, we answer once, asking a grown-up to write instead, and delete the message and '
          + 'the address no later than 7 days after it arrives. A child’s address is never added to any list.',
      },
      {
        fact: 'Parents can delete everything',
        heading: 'Parents can review and delete', rule: '§ 312.6', status: 'meets',
        text: 'We hold nothing about any child. Everything the app keeps is on the device: Clear Saved '
          + 'Progress on the About page, or deleting the app, erases it. A grown-up who has written to us '
          + 'can ask us to delete the message, and we will.',
      },
      {
        fact: 'Nothing asked in order to play',
        heading: 'Nothing asked in order to take part', rule: '§ 312.7', status: 'meets',
        text: 'Every lesson, puzzle and tool works without giving any information at all.',
      },
      {
        fact: 'Keeping information safe',
        heading: 'A security program', rule: '§ 312.8', status: 'meets',
        text: 'There is no children’s information for us to hold. Our support mailbox is protected with a '
          + 'strong password and two-step verification, and only Ira Learning LLC reads it. Every build of '
          + 'the app is checked automatically for anything that would collect or send information.',
      },
      {
        fact: 'How long anything is kept',
        heading: 'A written retention policy, published', rule: '§ 312.10', status: 'meets',
        text: 'On the device: until it is cleared or the app is deleted. A grown-up’s email: until we have '
          + 'finished helping, and no later than 12 months after the last message. A child’s email: no later '
          + 'than 7 days after it arrives.',
      },
      {
        fact: 'Everyone treated as possibly a child',
        heading: 'A mixed audience', rule: '§ 312.2 (directed to children)', status: 'meets',
        text: 'The app does not ask anyone’s age. It treats every person as possibly a child, so it needs no '
          + 'age screen.',
      },
      {
        fact: 'No links out, and no shop',
        heading: 'No links out, and no shop', rule: 'Good practice; Apple App Review Guidelines 1.3 and 5.1.4', status: 'meets',
        text: 'There are no links that leave the app, and the app refuses to open one. There are no purchases '
          + 'and no way to reach the App Store from inside the app.',
      },
    ],

    duties: [
      'Keep the support mailbox, support@iralearningllc.com, working, and check it at least once a week.',
      'Protect it with a strong, unique password and two-step verification.',
      'Answer a child once, asking a grown-up to write, and delete the child’s message within 7 days.',
      'Delete a grown-up’s messages once we have finished helping, and no later than 12 months after the last one.',
      'Never add anyone’s address, least of all a child’s, to a mailing list or any other list.',
      'Look over the app again every year, and before any version that changes what it does with information.',
    ],
  };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // The page's body: the same markup in the app and on the web. Facts only: no verdicts,
  // no status chips.
  function toHTML() {
    const facts = review.checks.map((c) => '<li class="coppa-check">'
      + '<h3>' + esc(c.fact) + '</h3>'
      + '<p>' + esc(c.text) + '</p></li>').join('');
    return '<p class="info-strong">What Cube Clubhouse does, and does not do, with children’s information. '
      + 'COPPA is the US law that protects the privacy of children under 13.</p>'
      + '<h3>Who the app is for</h3><p>' + esc(review.audience) + '</p>'
      + '<h3>The facts</h3><ul class="coppa-checks">' + facts + '</ul>'
      + '<h3>What we do, as the publisher</h3><ul>' + review.duties.map((d) => '<li>' + esc(d) + '</li>').join('') + '</ul>';
  }

  return { STATUS, review, toHTML };
});
