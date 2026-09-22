# fonts/

`fredoka-latin-var.woff2` is the typeface the app is drawn in, kept here rather than
fetched from Google Fonts. It is why the app makes no network requests at all: see the
Privacy page inside the app, and the `Content-Security-Policy` in `index.html`.

| | |
|---|---|
| Family | Fredoka, variable weight axis, latin subset |
| Licence | SIL Open Font License 1.1 — `OFL.txt`, included as the licence requires |
| Copyright | 2016 The Fredoka Project Authors |
| Size | 29 KB, one file for every weight the app uses (400–700) |

The font is third-party open-source software under its own licence, and is not part of
the proprietary Cube Clubhouse code covered by `../LICENSE`.

To refresh it, take the `latin` subset URL from
`https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap`
and save it here under the same name. Do not re-add the `<link>` to the page.
