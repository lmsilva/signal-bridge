/**
 * Shared push tile artwork, keyed by CommandDescriptor.icon.
 *
 * The bridge owns *what* can be pushed (`src/command-registry.js`); this file
 * owns what it looks like, for both the admin Push grid and the household
 * Push tab. Every pushable command carries its own key, so no two tiles draw
 * the same glyph — `test/command-registry.test.js` holds that line.
 */
(function (root) {
  const PUSH_ICONS = {
    'tesla-dashboard': '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M6.5 10.5 9 8l3 3 3.5-3.5L18 10"/>',
    'tesla-battery': '<rect x="2.5" y="7.5" width="17" height="9" rx="2"/><path d="M21.5 10.5v3"/><path d="M6 10.5v3M9.5 10.5v3M13 10.5v3"/>',
    photo: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" fill="currentColor" stroke="none"/><path d="m3 15 4-4 3 3 4-5 4 4"/><rect x="7" y="3" width="14" height="14" rx="2" opacity="0.45"/>',
    weather: '<path d="M7.5 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 12.1 3.5 3.5 0 0 0 7.5 18Z"/>',
    'weather-week': '<path d="M6.5 14h8a3.2 3.2 0 0 0 .4-6.38A4.8 4.8 0 0 0 5.5 8.9 2.8 2.8 0 0 0 6.5 14Z"/><path d="M4 18h1.5M8 18h1.5M12 18h1.5M16 18h1.5M20 18h.01"/><path d="M4 21h1.5M8 21h1.5M12 21h1.5M16 21h1.5"/>',
    'weather-alert': '<path d="M7.5 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6.2 12.1 3.5 3.5 0 0 0 7.5 18Z"/><path d="M12 8v4M12 14.5v.5"/>',
    'us-weather-map': '<path d="M3 7h11l2 2h5v6l-3 3H9l-3-2H3z"/><path d="M9 7v9M14 9v9"/>',
    'shopping-list': '<path d="M6 6h14l-1.5 9h-11z"/><path d="M6 6 5 3H3"/><circle cx="9.5" cy="19" r="1.5"/><circle cx="16.5" cy="19" r="1.5"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l3 2M9 2h6"/>',
    'guest-snaps': '<rect x="3" y="3" width="8" height="8" rx="1.5"/><path d="M5.5 7h3M7 5.5v3"/><rect x="13" y="13" width="8" height="8" rx="1.5"/><path d="M15 17h4M17 15v4"/><path d="M13 7h4M17 3v4M3 17h4M7 13v4"/>',
    'guest-book': '<path d="M4 5.5A2 2 0 0 1 6 4h12a1 1 0 0 1 1 1v13H6a2 2 0 0 0-2 2V5.5Z"/><path d="M6 18h13v2H6a2 2 0 0 1 0-2Z"/><path d="M9 8.5h6M9 11.5h4"/>',
    doorbell: '<rect x="6" y="3" width="12" height="18" rx="4"/><circle cx="12" cy="9" r="2"/><path d="M9.5 15h5"/>',
    'air-quality': '<path d="M4 14c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0 4-1.5 6.5 0"/><path d="M4 9c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0 4-1.5 6.5 0"/><path d="M4 19c2.5-1.5 4-1.5 6.5 0s4 1.5 6.5 0"/>',
    'now-playing': '<circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5-6-3.5Z" fill="currentColor" stroke="none"/>',
    alarm: '<path d="M6 9a6 6 0 1 1 12 0c0 3.5 1.5 5 2 6H4c.5-1 2-2.5 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/><path d="M12 3v1"/>',
    notification: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="m3.5 6.5 8.5 6 8.5-6"/><circle cx="19" cy="6" r="3" fill="currentColor" stroke="none"/>',
    'quiet-hours': '<path d="M14.5 4.5A7.5 7.5 0 1 0 19.5 16 6.2 6.2 0 0 1 14.5 4.5Z"/><path d="M16.2 6.2 17 4.4M18.4 8.8l1.6-.6M19.2 12l1.8.2"/>',
    trivia: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.6 2.6 0 1 1 3.2 2.5c-.5.2-.7.6-.7 1.1v.5"/><path d="M12 16.6v.4"/>',
    riddle: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.2 9.6a2.6 2.6 0 1 1 3.4 2.4c-.6.4-1 .9-1 1.7"/><circle cx="12" cy="16.2" r=".7" fill="currentColor" stroke="none"/>',
    scramble: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h2v2H8zM11 8h2v2h-2zM14 8h2v2h-2zM8 11h2v2H8zM11 11h2v2h-2zM14 11h2v2h-2zM8 14h2v2H8zM11 14h2v2h-2zM14 14h2v2h-2z"/>',
    prompts: '<rect x="2.5" y="4" width="13" height="9" rx="2.5"/><path d="M6.5 13v3.4L10.4 13"/><path d="M15.8 8.5h2.7A2.5 2.5 0 0 1 21 11v4.5a2.5 2.5 0 0 1-2.5 2.5H18v3l-3.6-3h-2.6"/>',
    wheel: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M6.2 6.2l2.5 2.5M15.3 15.3l2.5 2.5M17.8 6.2l-2.5 2.5M8.7 15.3l-2.5 2.5"/>',
    hangman: '<path d="M2.5 20.5h6M5.5 20.5V3.5h10"/><path d="M15.5 3.5v3"/><circle cx="15.5" cy="8.5" r="2"/><path d="M15.5 10.5v5M12.5 12.5h6M15.5 15.5l-2.5 4M15.5 15.5l2.5 4"/>',
    news: '<path d="M4 5.5h12.5A2.5 2.5 0 0 1 19 8v11H6.5A2.5 2.5 0 0 1 4 16.5v-11Z"/><path d="M8 9h6M8 12h6M8 15h3.5"/><path d="M19 10.5h1.5A1.5 1.5 0 0 1 22 12v5.5A1.5 1.5 0 0 1 20.5 19H19"/>',
    wiki: '<path d="M5 4.5h8a2 2 0 0 1 2 2v13H7a2 2 0 0 1-2-2v-13Z"/><path d="M9 4.5V3h6v1.5"/><path d="M8 10h6M8 13.5h4"/>',
    japanese: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.6" fill="currentColor" stroke="none"/>',
    portuguese: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 12h18"/><circle cx="9" cy="12" r="3"/>',
    spanish: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18M3 15h18"/>',
    french: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14"/>',
    german: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9.7h18M3 14.3h18"/>',
    italian: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>',
    chuck: '<circle cx="12" cy="8.5" r="3.2"/><path d="M7 20c.6-3.2 2.6-5 5-5s4.4 1.8 5 5"/><path d="M5 10.5c2-.8 4-.8 7-.8s5 0 7 .8"/><path d="M8.2 13.2 6.5 15M15.8 13.2 17.5 15"/>',
    amazing: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="m8.5 4.5 1 1.5M15.5 4.5l-1 1.5M5.5 9l1.5.8M18.5 9l-1.5.8"/>',
    talk: '<path d="M5 6.5h10a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H10l-3.5 3v-3H5a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Z"/><path d="M14 9.5h5a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-1v2l-2.5-2"/>',
    stoic: '<path d="M8 4h8v3.5c0 2.2-1.8 4-4 4s-4-1.8-4-4V4Z"/><path d="M7 20c.8-3.5 2.8-5.5 5-5.5s4.2 2 5 5.5"/><path d="M9.5 9.5h5"/>',
    'bible-verse': '<path d="M4 5h7a2 2 0 0 1 2 2v13H6a2 2 0 0 1-2-2V5Z"/><path d="M20 5h-7a2 2 0 0 0-2 2v13h7a2 2 0 0 0 2-2V5Z"/><path d="M12 7v12"/><path d="M11.2 10h1.6M12 9.2v3"/>',
    history: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/><path d="M16.5 15.5 18 18"/>',
    bake: '<path d="M7 14h10v5H7z"/><path d="M8 14c0-3 1.5-6 4-6s4 3 4 6"/><path d="M9 9.5c.5-1.5 1.5-2.5 3-2.5s2.5 1 3 2.5"/><path d="M6 19h12"/>',
    stocks: '<path d="M4 18V6M4 18h16"/><path d="m7 14 3-4 3 2 4-6"/>',
    currency: '<circle cx="12" cy="12" r="9"/><path d="M12 6v12M9.5 9.5c.6-1 1.6-1.5 2.5-1.5 1.4 0 2.5.9 2.5 2s-1.1 2-2.5 2h-1c-1.4 0-2.5.9-2.5 2s1.1 2 2.5 2c.9 0 1.9-.5 2.5-1.5"/>',
    world: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.8 3.2 2.8 14.8 0 18M12 3c-2.8 3.2-2.8 14.8 0 18"/><path d="M5.5 7.5c2 .8 4 .8 6.5.8s4.5 0 6.5-.8M5.5 16.5c2-.8 4-.8 6.5-.8s4.5 0 6.5.8"/>',
    population: '<circle cx="8.5" cy="8" r="2.8"/><path d="M3.5 19c.5-3 2.4-4.8 5-4.8s4.5 1.8 5 4.8"/><circle cx="16.5" cy="6.5" r="2.2"/><path d="M15 12.2c2.4-.6 4.6.9 5.4 4"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01M12 17h.01"/>',
    'red-letter': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/><path d="m12 12.8 1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4Z" fill="currentColor" stroke="none"/>',
    'word-clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>',
    roast: '<path d="M12 3c2.8 3 4.2 5.3 4.2 7a4.2 4.2 0 0 1-8.4 0c0-1.7 1.4-4 4.2-7z"/><path d="M6.5 14.5c-.9 1.2-1.4 2.4-1.4 3.4C5.1 20.2 8 22 12 22s6.9-1.8 6.9-4.1c0-1-.5-2.2-1.4-3.4"/>',
    'family-quotes': '<path d="M12 20.5S4 15.8 4 10.2A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 8 2.2c0 5.6-8 10.3-8 10.3z"/>',
    'warm-fuzzies': '<path d="M12 20.5S4 15.8 4 10.2A4.2 4.2 0 0 1 12 8a4.2 4.2 0 0 1 8 2.2c0 5.6-8 10.3-8 10.3z"/><path d="M8.5 10.5c1.2-1.5 3-2.2 3.5-.5.5-1.7 2.3-1 3.5.5"/>',
    'daily-bucket-fillers': '<path d="M7 8h10l-1.2 11H8.2L7 8z"/><path d="M6 8h12"/><path d="M9 8V6.5A3 3 0 0 1 15 6.5V8"/><path d="M10 12h4"/>',
    'misheard-lyrics': '<path d="M9 18V6l10-2v12"/><circle cx="7" cy="18" r="2.2"/><circle cx="17" cy="16" r="2.2"/><path d="M9 10l10-2"/>',
    'periodic-table': '<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="13" width="7" height="7" rx="1"/><rect x="14" y="13" width="7" height="7" rx="1"/>',
    'state-facts': '<path d="M4 7h11l2 2h3v6l-3 3H8l-2-2H4z"/><path d="M8 9.5h.01M12 8.5h.01M15 11h.01M10 13h.01"/>',
    'word-of-the-day': '<path d="M4 5h16v3H4z"/><path d="M6 11h3v8H6z"/><path d="M11 11h3v8h-3z"/><path d="M16 11h3v8h-3z"/>',
    'dad-jokes': '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>',
    sky: '<circle cx="12" cy="12" r="9"/><path d="M8 14h8"/><path d="m12 8 2 2-2 2-2-2 2-2Z" fill="currentColor" stroke="none"/><path d="M6 10h2M16 10h2"/>',
    'flight-next': '<path d="M2 16l20-5-5 5 5 5-20-5 5-5-5-5Z"/><path d="M12 12v9"/>',
    'flight-board': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 8.5h18"/><path d="M6.5 12h4M13.5 12h4M6.5 16h4M13.5 16h4"/>',
    iss: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2"/><path d="M3 12h4M17 12h4M12 3v4M12 17v4"/><path d="M7.5 7.5l2 2M14.5 14.5l2 2M16.5 7.5l-2 2M9.5 14.5l-2 2"/>',
    starlink: '<circle cx="12" cy="12" r="9"/><path d="M5 12h14M12 5v14"/><circle cx="7" cy="8" r="1.1" fill="currentColor" stroke="none"/><circle cx="16" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="15" cy="15" r="1.1" fill="currentColor" stroke="none"/><circle cx="8" cy="16" r="0.9" fill="currentColor" stroke="none"/>',
    'launch-alert': '<path d="M12 3l8 14H4L12 3z"/><path d="M12 10v4M12 17h.01"/>',
    youtube: '<rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10.2 9.6v4.8l4.3-2.4-4.3-2.4Z" fill="currentColor" stroke="none"/>',
    steam: '<circle cx="12" cy="12" r="9"/><circle cx="15" cy="9.5" r="2.4"/><path d="M3.3 15.2 8 17.1"/><circle cx="9" cy="15.6" r="2.1"/>',
    'steam-library': '<rect x="3" y="4" width="4" height="16" rx="1"/><rect x="8.5" y="4" width="4" height="16" rx="1"/><path d="m14.5 6.2 3.9-1 3.1 12.6-3.9 1z"/><circle cx="5" cy="16.5" r="1" fill="currentColor" stroke="none"/>',
    psn: '<path d="M10 4.5 15 6v12.5l-2.6-.9V8.2L10 7.5Z" fill="currentColor" stroke="none"/><path d="M4 15.2c2-1.1 4.4-1.5 4.4-1.5v2s-2.1.4-3 .9c-.4.2-.3.5.2.5"/><path d="M20 14.4c-1.6-.9-4-.7-4-.7v1.9s1.9-.3 2.8 0"/>',
    'psn-library': '<rect x="3" y="4" width="4" height="16" rx="1"/><rect x="8.5" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/><path d="M19.5 7.5 22 8.2 19.8 20"/>',
    credits: '<path d="M7 4h10v4a5 5 0 0 1-10 0V4Z"/><path d="M7 6H4v2a4 4 0 0 0 4 4M17 6h3v2a4 4 0 0 1-4 4M12 13v4M8 20h8M9 17h6"/>',
    autodarts: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.5"/><circle cx="12" cy="12" r="2"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
    'autodarts-dashboard': '<circle cx="7" cy="7.5" r="4.2"/><circle cx="7" cy="7.5" r="1.4"/><path d="M14 4.5h7M14 8h5"/><path d="M4 21V15M9 21v-4M14 21v-8M19 21v-5"/>',
    huupe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    'huupe-dashboard': '<rect x="3" y="3.5" width="18" height="11" rx="1.5"/><path d="M8.5 14.5h7v3h-7z"/><path d="M12 17.5v3"/><circle cx="12" cy="8.5" r="2.6"/>',
    plex: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M8 8v8l7-4-7-4Z" fill="currentColor" stroke="none"/>',
    'plex-top10': '<path d="M4 20V11h4v9zM10 20V5h4v15zM16 20v-6h4v6z"/><path d="M3 20h18"/>',
  };

  function pushIconSvg(icon) {
    const body = PUSH_ICONS[icon] || PUSH_ICONS['now-playing'];
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  }

  root.PUSH_ICONS = PUSH_ICONS;
  root.pushIconSvg = pushIconSvg;
})(typeof window !== 'undefined' ? window : globalThis);
