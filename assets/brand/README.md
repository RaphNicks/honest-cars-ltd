# The brand master

Drop the company's logo artwork in this directory as **`logo.png`** (a `.jpg`,
`.jpeg`, `.webp` or `.tiff` also works — the file is what counts, not the name
of the folder or the extension you upload it with).

Then, from the repository root:

```
npm run icons      # cuts every size from the master
npm run icons:check # verifies nothing has drifted since
npm run build:static
```

`scripts/generate-icons.js` reads the master once and writes everything the site
shows as "the logo":

| File | Where it appears |
| --- | --- |
| `public/img/logo.png` | The header, the mobile drawer, the console bar |
| `public/favicon.png` | Browser tabs and bookmarks |
| `public/icons/icon-192.png` · `icon-512.png` | Install banner, app switcher |
| `public/icons/maskable-192.png` · `maskable-512.png` | Android home screen |
| `public/icons/apple-touch-icon.png` | iOS home screen |
| `public/manifest.webmanifest` | The install record, listing the icons above |

The master's own black field is kept — the mark was drawn on it — and the
artwork is trimmed of whatever margin the upload carries first. Derived files
are committed, so the site deploys without a build step that only runs here.

**Without a master** the script draws the shield-and-check placeholder into the
same filenames, and `public/img/logo.png` is absent — which is how the header,
the drawer and the console know to draw their inline shield instead. Nothing
ever points at a logo that is not there.

Expect a source file of roughly 1000–2000px on the long edge; `trim` + `lanczos3`
down-scaling mean anything larger is wasted bytes, and anything much smaller
will soften at 512px.
