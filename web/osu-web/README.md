# osu-web artwork

Copied unmodified from [ppy/osu-web](https://github.com/ppy/osu-web/tree/705b1d82987931095364fd2acb5407d8b9a7f04a) at commit `705b1d82987931095364fd2acb5407d8b9a7f04a` by
`scripts/build-osu-web-art.mjs`. **Do not edit these files**; run the script again instead.

Copyright (c) ppy Pty Ltd <contact@ppy.sh>. Licensed under the GNU Affero General Public
License v3.0 or later, as osu-web is. See `LICENSE` and `THIRD-PARTY-NOTICES.md` at the root
of this repository.

"osu!" and "ppy" are trademarks of ppy Pty Ltd. This project is not affiliated with or endorsed
by ppy.

| folder | osu-web source | used for |
|---|---|---|
| `mods/` | `public/images/badges/mods/` | the glyph in each mod badge, and the badge blanks |
| `grades/` | `public/images/badges/score-ranks-v2019/` | the small grade badges |
| `scores/` | `resources/images/scores/` | a stable score's big grade letter |
| `layout/` | `public/images/layout/` | the avatar of a profile with no picture |
| `covers/` | `public/images/headers/profile-covers/c3.jpg` at commit `770e5d41a20f6b3fd62be5b599a2f1c8cce6c87c` | the banner of a profile with none of its own |
| `modes/` | `resources/fonts/extra/extra.svg`, glyphs mode-osu, mode-taiko, mode-ctb, mode-mania | the mode switcher's ruleset icons |

`modes/` is the one folder that is not a copied file: osu-web keeps the ruleset icons only as
glyphs of its icon font, so each glyph's outline is written out as an SVG of its own, unchanged
but for the flip from the font's upward y axis to an image's downward one. The font itself is
not taken: it also holds the osu! logo.

`covers/` is the one folder from another commit: osu-web's built-in profile banners were
removed from the repository in 6b22ecb, when cover presets moved to a database table, so the
banner comes from the last commit that still had them.
