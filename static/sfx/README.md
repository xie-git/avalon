# Sound effects

Short effects played by `static/js/showtime.js`. All samples are from Kenney's
public-domain packs (CC0 1.0, https://kenney.nl), converted to mono MP3:

| Pack | Files |
| --- | --- |
| Casino Audio | `shuffle`, `place1-3`, `slide1-3`, `token1-3`, `fan`, `stack` |
| RPG Audio | `coins`, `blade`, `slash`, `door-open`, `door-close`, `book-open`, `page`, `book-close`, `cloth` |
| Impact Sounds | `bell`, `clang`, `stamp`, `thud`, `shatter` |
| Music Jingles (Pizzicato, Hit) | `j-*`, `hit-*` |

Drumrolls, heartbeats, booms, ticks, shimmers, gongs, choir pads and fanfares
are synthesised at runtime with Web Audio and have no files.

Changing a file requires bumping `ASSET_VERSION` in `static/js/showtime.js`
(files are served with one-year immutable caching).
