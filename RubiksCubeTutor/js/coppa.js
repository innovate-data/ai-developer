/* Cube Clubhouse - Copyright (c) 2026 Ira Learning LLC. All rights reserved. Proprietary software. See LICENSE, or the Licence page inside the app. */
/*
 * coppa.js - the COPPA Review, as data, and the one function that draws it.
 *
 * The app's COPPA Review page (About > COPPA Review, or COPPA in the footer) and the
 * hosted ios/app-store/coppa.html are both drawn by toHTML() from the data below, so the
 * two cannot say different things. COPPA-REVIEW.md is the full written review, with the
 * technical evidence; a unit test checks that its table agrees with these checks.
 *
 * This is an engineering review, not legal advice.
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
    reviewed: '5 November 2026',
    appVersion: '1.0',
    rule: 'the Children’s Online Privacy Protection Rule (16 CFR Part 312), as amended in 2025, with compliance required from 22 April 2026',

    applies: {
      answer: 'Yes, and we act as if it does for everyone.',
      text: 'Cube Clubhouse is made for all ages, but its subject, its pictures and its plain words appeal '
        + 'to children, and children use it. So we treat it as directed to children and apply COPPA to '
        + 'every person who opens it. The iPhone and iPad app can reach the internet, for its update '
        + 'check, which makes it an online service in COPPA’s sense. We meet the rule the simplest way '
        + 'there is: the app collects nothing from anyone, so there is nothing for a parent to consent to.',
    },

    checks: [
      {
        heading: 'No personal information is collected',
        rule: '§ 312.2, § 312.3',
        status: 'meets',
        text: 'There are no accounts, sign-ins, forms, chat or boxes to type words into. Stars, times and '
          + 'settings stay on the device and are never sent to us or anyone else. Nothing the app asks for '
          + 'is personal: the only keypad is the grown-up check before the App Store, and what is typed there '
          + 'is not kept.',
      },
      {
        heading: 'Persistent identifiers only for internal operations',
        rule: '§ 312.2 (support for the internal operations), § 312.5(c)(7)',
        status: 'meets',
        text: 'The app makes and reads no identifier: no advertising identifier, no vendor identifier, no '
          + 'device ID, no cookies. Its one request, the App Store update check, carries only the app’s '
          + 'bundle identifier and the country, and like any request it reaches Apple from the network’s '
          + 'address. It exists only to keep the app working and up to date, which is the internal support '
          + 'COPPA allows; we never receive it, and it can be switched off under About › Updates.',
      },
      {
        heading: 'No third party collects through the app',
        rule: '§ 312.2 (operator, third party)',
        status: 'meets',
        text: 'There is no third-party code at all: no advertising, analytics, crash reporting, social '
          + 'buttons or software kits. Apple, whose phone and store the app runs on, is the only other '
          + 'party it ever reaches: for the update check, and for the App Store page a grown-up opens.',
      },
      {
        heading: 'Separate consent before sharing with third parties',
        rule: '§ 312.5(a)(2)',
        status: 'not-needed',
        text: 'Nothing is collected, so nothing is shared, sold or disclosed to anyone.',
      },
      {
        heading: 'Online notice, linked prominently',
        rule: '§ 312.4(d)',
        status: 'meets',
        text: 'The Privacy page is one tap from every screen (Privacy, at the bottom) and is published '
          + 'at the same words for the App Store listing. It names us and how to reach us, lists '
          + 'everything the app keeps and where, says how long anything is kept, and explains a '
          + 'parent’s rights.',
      },
      {
        heading: 'Direct notice to parents and their consent',
        rule: '§ 312.4(b)–(c), § 312.5',
        status: 'not-needed',
        text: 'These apply when a child’s information is collected. None is, so there is no notice to send '
          + 'and no consent to ask for.',
      },
      {
        heading: 'Replying once to a child who writes',
        rule: '§ 312.5(c)(3)',
        status: 'meets',
        text: 'The app has no email link, and asks children to have a grown-up write for them. If a child '
          + 'writes anyway, we answer once, asking a grown-up to write instead, and delete the message and '
          + 'the address no later than 7 days after it arrives. A child’s address is never added to any list.',
      },
      {
        heading: 'Parents can review and delete',
        rule: '§ 312.6',
        status: 'meets',
        text: 'We hold nothing about any child. Everything the app keeps is on the device: Clear Saved '
          + 'Progress on the About page, or deleting the app, erases it. A grown-up who has written to us '
          + 'can ask us to delete the message, and we will.',
      },
      {
        heading: 'Nothing asked in order to take part',
        rule: '§ 312.7',
        status: 'meets',
        text: 'Every lesson, puzzle and tool works without giving any information at all.',
      },
      {
        heading: 'A security program',
        rule: '§ 312.8',
        status: 'meets',
        text: 'There is no children’s information for us to protect. Our support mailbox is protected with a '
          + 'strong password and two-step verification, and only Ira Learning LLC reads it. This review is our '
          + 'written security and retention program; the build refuses any change that would start collecting '
          + 'or sending information, and we repeat the review every year.',
      },
      {
        heading: 'A written retention policy, published',
        rule: '§ 312.10',
        status: 'meets',
        text: 'The Privacy page says how long each thing is kept: on the device until it is cleared or the app '
          + 'is deleted; a grown-up’s email until we have finished helping, and no later than 12 months after '
          + 'the last message; a child’s email no later than 7 days after it arrives.',
      },
      {
        heading: 'A mixed audience',
        rule: '§ 312.2 (directed to children)',
        status: 'meets',
        text: 'The app does not ask anyone’s age. Rather than sort users, it treats every one of them as '
          + 'possibly a child, which is stricter than the rule requires and needs no age screen.',
      },
      {
        heading: 'No links out, and the shop behind a grown-up',
        rule: 'Good practice; Apple App Review Guidelines 1.3 and 5.1.4',
        status: 'meets',
        text: 'There are no links that leave the app, and the app refuses to open one. The only way to the '
          + 'App Store is the Update button, and a grown-up answers a times-table question before it opens.',
      },
      {
        heading: 'A safe harbor program',
        rule: '§ 312.11',
        status: 'optional',
        text: 'Joining an FTC-approved safe harbor program is voluntary. It is not needed for an app that '
          + 'collects nothing, but it is an option if Ira Learning LLC wants outside certification.',
      },
    ],

    duties: [
      'Keep the support mailbox, iralearningllc@gmail.com, working, and check it at least once a week.',
      'Protect it with a strong, unique password and two-step verification.',
      'Answer a child once, asking a grown-up to write, and delete the child’s message within 7 days.',
      'Delete a grown-up’s messages once we have finished helping, and no later than 12 months after the last one.',
      'Never add anyone’s address, least of all a child’s, to a mailing list or any other list.',
      'Keep COPPA-REVIEW.md as the written security and retention program, and repeat the review every year.',
    ],

    changes: [
      'Accounts, sign-in, or any way of saving progress anywhere but the device',
      'Analytics, crash reporting or any measuring of how the app is used',
      'Advertising of any kind',
      'Links out of the app, or any way to share',
      'The camera, the microphone, location or contacts',
      'Chat, messages or any box for typing words',
      'Any new software kit, library or plug-in',
    ],
  };

  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // The page's body: the same markup in the app and on the web. opts.version is the app
  // version to show; opts.privacyHref is where "the Privacy page" points.
  function toHTML(opts) {
    const o = opts || {};
    const version = esc(o.version || review.appVersion);
    const privacy = esc(o.privacyHref || '#privacy');
    const checks = review.checks.map((c) => '<li class="coppa-check">'
      + '<div class="coppa-head"><h3>' + esc(c.heading) + '</h3>'
      + '<span class="coppa-chip coppa-' + c.status + '">' + STATUS[c.status] + '</span></div>'
      + '<p class="coppa-rule">' + esc(c.rule) + '</p>'
      + '<p>' + esc(c.text) + '</p></li>').join('');
    return '<p class="info-strong">We checked Cube Clubhouse against COPPA, the US law that protects '
      + 'the privacy of children under 13, rule by rule.</p>'
      + '<p>The rule is ' + esc(review.rule) + '.</p>'
      + '<h3>Does COPPA apply?</h3><p><b>' + esc(review.applies.answer) + '</b> ' + esc(review.applies.text) + '</p>'
      + '<h3>Requirement by requirement</h3><ul class="coppa-checks">' + checks + '</ul>'
      + '<h3>What we do, as the publisher</h3><ul>' + review.duties.map((d) => '<li>' + esc(d) + '</li>').join('') + '</ul>'
      + '<h3>What would change the answer</h3><p>Any of these would need this review done again, and most '
      + 'would need a parent’s consent first. None is in the app:</p><ul>'
      + review.changes.map((d) => '<li>' + esc(d) + '</li>').join('') + '</ul>'
      + '<h3>About this review</h3><p class="coppa-about">An engineering review of Cube Clubhouse version '
      + '<b class="coppa-version">' + version + '</b>, done on ' + esc(review.reviewed) + ' and repeated '
      + 'every year. It is not legal advice. The <a href="' + privacy + '">Privacy</a> page says exactly '
      + 'what the app keeps. Questions: Ira Learning LLC, iralearningllc@gmail.com.</p>';
  }

  return { STATUS, review, toHTML };
});
