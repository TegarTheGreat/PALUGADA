<picture>
  <source media="(prefers-color-scheme: dark)" srcset="banners/palugada-banner-dark.png">
  <img alt="PALUGADA" src="banners/palugada-banner-light.png">
</picture>

# The PALUGADA brand

Everything the product is drawn with: the logo in every shape a place asks
for, the banners, and the pictures the console uses for companies, roles and
the owner. `test/documents/console-images.test.ts` holds the kit to what this
page says: every vector here is named below, every PNG is the size its name
gives, and nothing in the console is drawn from the letters of a name.

## The mark

A crate seen from the front, with a spark on it. *Palugada* is Jakarta slang
for "whatever you need, it's here" (*apa lu mau, gua ada*): a company that can
be asked for anything and has it. The crate is a hexagon because a company
here is a structure -- divisions, roles, budgets -- and its two tones are the
two sides of the product, the agents who do the work and the one owner who
decides what cannot be undone. The spark is the work coming out of it.

It is never drawn as a letter. The console used a gradient "P" and the first
letter of every company's name; both are gone.

## Colours

| Name | Hex | Where |
|---|---|---|
| Indigo | `#4f46e5` | the mark's front face, the product's primary colour (`brand.6` in `console/src/main.tsx`) |
| Deep indigo | `#312e81` | the mark's sides |
| Ink | `#1e1b4b` | the wordmark, text on light backgrounds |
| Violet | `#be4bdb` | the far end of the icon gradient |
| Lavender | `#c7d2fe` | the mark's sides when it is drawn white on the gradient |
| Light indigo | `#818cf8` | the mark's front face on dark backgrounds |

The console's type is Inter. The wordmark is not set in a font: its letters
are outlined paths, so it looks the same wherever it is opened.

## Vectors (`svg/`)

| File | Use it for |
|---|---|
| `palugada-mark.svg` | the mark on a light background |
| `palugada-mark-on-dark.svg` | the mark on a dark background |
| `palugada-mark-mono-black.svg` | one colour: print, stamps, embossing |
| `palugada-mark-mono-white.svg` | one colour, reversed out of a dark or photographic background |
| `palugada-mark-mono-indigo.svg` | one colour in the brand indigo |
| `palugada-wordmark.svg` | the name alone, in ink |
| `palugada-wordmark-white.svg` | the name alone, on dark |
| `palugada-wordmark-indigo.svg` | the name alone, in indigo |
| `palugada-lockup.svg` | mark and name side by side: headers, documents, the console's sidebar |
| `palugada-lockup-on-dark.svg` | the same, on dark |
| `palugada-lockup-mono-black.svg` | the same, one colour |
| `palugada-lockup-mono-white.svg` | the same, one colour reversed |
| `palugada-lockup-stacked.svg` | mark above name: square-ish spaces, title slides |
| `palugada-lockup-stacked-on-dark.svg` | the same, on dark |
| `palugada-app-icon.svg` | the app icon: the mark in white and lavender on the gradient, rounded |
| `palugada-app-icon-light.svg` | the app icon on white |
| `palugada-app-icon-dark.svg` | the app icon on ink |
| `palugada-square.svg` | full-bleed square: social profiles, GitHub organisation avatar |
| `palugada-circle-avatar.svg` | already round, for places that do not crop |
| `palugada-maskable.svg` | Android's adaptive icon: the mark inside the safe circle |
| `palugada-symbol-crate.svg` | a secondary symbol, the open crate, for illustrations |
| `palugada-symbol-team.svg` | a secondary symbol, one owner and six agents, for illustrations |

Give the mark clear space of a quarter of its height on every side, and do not
draw it smaller than 16 pixels (the app icon) or the lockup narrower than 96.
Do not recolour it outside the variants above, stretch it, or put the
full-colour mark on a background that swallows the deep indigo -- use the
`on-dark` or mono variants there.

## PNGs (`png/`)

Every vector that is used as a picture somewhere has PNG exports, named by
size: `-512.png` is 512 by 512; `-1200w.png` is 1200 wide. The app icon comes
at 16, 32, 48, 64, 128, 180, 192, 256, 512 and 1024; the mark at 64 to 1024;
the lockups at 600, 1200 and 2400 wide. `favicon.ico` holds 16, 32 and 48.

## Banners (`banners/`)

| File | Size | Use it for |
|---|---|---|
| `palugada-banner-dark.png`, `palugada-banner-light.png` | 1280 × 320 | the top of a README; this page shows the one matching the reader's theme |
| `palugada-og.png` | 1200 × 630 | link previews (Open Graph, Slack, WhatsApp) |
| `palugada-social-preview.png` | 1280 × 640 | GitHub's repository social preview |
| `palugada-header-x.png`, `palugada-header-light.png` | 1500 × 500 | X / Twitter header |
| `palugada-header-linkedin.png` | 1584 × 396 | LinkedIn banner |
| `palugada-strip.png` | 1600 × 200 | a thin strip for email headers and slides |

The artwork behind them is in `backgrounds/`, without the logo or text, for
new sizes.

## The console's pictures (`console/public`)

- `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icon-192.png`,
  `icon-512.png`, `icon-maskable-512.png` and `manifest.webmanifest`: what a
  browser or a phone's home screen shows.
- `brand/`: the mark, the app icon and the lockups the console draws in its
  sidebar and on the sign-in page, and `palugada-profile.jpg`, the square at
  640 pixels as a JPEG: the Telegram bot's profile photo, which Telegram takes
  only as a JPEG, sent from the console and shown beside its button.
- `avatars/companies/`: twelve emblems. A company is drawn as what its name
  says it sells, in Indonesian or English -- Kopi Nusantara as coffee, Toko
  Sari as a shop -- and a company whose name says nothing gets one from its
  id, so it keeps it when renamed (`console/src/images.ts`). Two companies
  whose names start with the same letter no longer look alike.
- `avatars/roles/`: one agent, drawn doing fifteen jobs -- coordinator,
  planner, builder, marketer, bookkeeper, responder, reviewer, analyst,
  strategist, researcher, writer, web operator, engineer, sales, designer --
  and four plain agents for a role whose name does not say what it does. The
  picture is read from the words of the role's slug, so a role the owner hires
  as `content-writer` is drawn writing.
- `avatars/owner.webp`: the owner.

## How it was made

With fal (fal.ai):

- The mark, the wordmark and the two secondary symbols with Recraft V4.1
  text-to-vector (`fal-ai/recraft/v4.1/text-to-vector`), in the brand colours
  given to the model. The generator's output was then cleaned -- its
  provenance metadata, background rectangle and anti-aliasing slivers removed,
  the letters' counters cut as holes -- and every variant above composed from
  those same paths, so the mark is one drawing in every file.
- The banner artwork with Nano Banana Pro (`fal-ai/nano-banana-pro`), with the
  logo and the line of text set over it afterwards so they are exact.
- The console's pictures with Nano Banana Pro's editor
  (`fal-ai/nano-banana-pro/edit`): one agent drawn first, and every role, the
  owner and the company emblems drawn from it as a reference, so they are one
  family. Each was cropped to its subject and saved as a 256-pixel WebP.

PNGs are rendered from the vectors by Chromium, so they match the SVGs pixel
for pixel.
