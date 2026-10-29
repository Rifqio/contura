# Icon licences

Each set's current terms, read again from the official source on 2026-10-26 (first read 2026-10-19) before packing. The pack is `src-tauri/icons-pack/icons.bin`, written by `scripts/pack-icons.mjs`. The app's Icon credits dialog reads each set's title, licence, source link, note and licence text from the pack (`icon_sets`).

## Summary

| Set | Source | Licence or terms | Bundled | Icons packed | Left out by the safety check |
|---|---|---|---|---|---|
| AWS Architecture Icons | https://aws.amazon.com/architecture/icons/ | AWS terms: for creating architecture diagrams | Yes | 736 (+14 aliases) | 0 |
| Azure architecture icons | https://learn.microsoft.com/azure/architecture/icons/ | Microsoft icon terms: architectural diagrams, training materials, documentation | Yes | 633 (+5 aliases) | 0 |
| Google Cloud icons | https://cloud.google.com/icons | Google: for building your own architecture diagrams | Yes | 251 | 0 |
| Kubernetes icons | https://github.com/kubernetes/community/tree/main/icons | Apache-2.0 or CC-BY-4.0 (we use CC-BY-4.0) | Yes | 39 (+16 aliases) | 0 |
| Lucide | https://lucide.dev/license | ISC; Feather-derived icons also MIT | Yes | 2,171 (+1 alias) | 0 |
| Simple Icons | https://simpleicons.org, https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md | CC0-1.0; some icons carry their own licence | Yes, a chosen subset | 759 | 0 |

No set's terms forbid bundling the icons in a diagramming app, so no set is left out. Four Simple Icons brands are left out for their own licences (below).

Pack (version 2): 4,625 names, 3,098,560 bytes (limit 4 MB; the build refuses 4 MB or more). Per set: AWS 984,579 bytes, Azure 595,679, Google Cloud 161,128, Kubernetes 102,962, Lucide 594,784, Simple Icons 571,269. The index is 327,701 bytes unpacked. Every name of the earlier pack (4,069) still resolves.

How icons are changed: an icon is fitted, never redrawn. The pack rewrites only the root `<svg>` start tag: the source's attributes stay in order, except `width`, `height`, `viewBox` and `preserveAspectRatio`, which are dropped, and a 24 by 24 frame is appended. The bytes before the root tag (XML declaration, Lucide's `@license` comment) and everything after it (the whole drawing) are copied unchanged. The fit is uniform, a non-square artboard is centred, and nothing is cropped, stretched, flipped, rotated or recoloured, as the Azure and AWS terms require. Each set has a margin (`PAD` in `scripts/pack-icons.mjs`, a fraction of the 24 unit frame, set from a contact sheet):

| Set | PAD |
|---|---|
| AWS | 2.5/24 |
| Azure | 2.5/24 |
| Google Cloud | 0.5/24 |
| Kubernetes | 2.5/24 |
| Lucide | 0 (its 24 grid already keeps the margin) |
| Simple Icons | 2.5/24 |

Light and dark ink: outline icons (Lucide) are drawn in the theme's text colour, `#1f1f1f` on light and `#f8f8f2` on dark. Logos (Simple Icons) keep their brand colour (WCAG exempts logos from its contrast rule) down to 1.5:1 (WCAG 2.x contrast) against the theme's canvas, `#f8f4e3` light and `#21222c` dark. Below that, a pale logo on light keeps its colour and gets a hairline outline in the text colour (`icon-hairline` on the canvas, one SVG filter in Publish), and a dark logo on dark is drawn in the text colour. All 759 logos keep their colour on light (50 of them outlined, such as JavaScript, DuckDB and Better Auth), 598 on dark. The pack stores one copy of each; the front end picks the ink and the Core adds ` color="<ink>"` to the root tag when it serves the icon, and `currentColor` in the file follows it. Colour icons (AWS, Azure, Google Cloud, Kubernetes) are never inked. Each set's credits line says what was changed (`changes`).

## AWS Architecture Icons

- Source: https://aws.amazon.com/architecture/icons/ (read 2026-10-19, again 2026-10-26: wording unchanged).
- Download: `Icon-package_07312026.5846e92413caa21490223536cc97f1269e44fa92.zip` from d1.awsstatic.com (release 07312026, still current on 2026-10-26).
- Terms, as the page states them: "We allow customers and partners to use these toolkits and assets to create architecture diagrams." and "You can also put icons in materials like whitepapers, presentations, data sheets, and posters." The page names no licence and says nothing about redistribution inside software.
- Reading: Contura ships the icons so that users can draw architecture diagrams with them, which is the use AWS allows. Nothing forbids bundling. Amazon, AWS and the service icons stay trademarks of Amazon.com, Inc. or its affiliates.
- Conditions we keep: icons used only to name AWS services in diagrams, never as Contura's own branding; unchanged; credit in Icon credits.
- Packed: the service icons at 64 px (`Arch_*_64.svg`), the resource icons (`Res_*_48.svg`) and the group icons (`*_32.svg`, light and dark). Names drop the Amazon/AWS prefix: `Arch_Amazon-DynamoDB_64.svg` is `aws-dynamodb`. Aliases: `aws-s3`, `aws-sqs`, `aws-sns`, `aws-ses`, `aws-iam`, `aws-ebs`, `aws-ecs`, `aws-eks`, `aws-ecr`, `aws-elb`, `aws-vpc`, `aws-msk`, `aws-kms`, `aws-apigateway`. 3 names came twice once the prefix was dropped (`compute-optimizer`, `ec2-auto-scaling`, `kinesis-video-streams`); the service icon is kept.

## Azure architecture icons

- Source: https://learn.microsoft.com/en-us/azure/architecture/icons/ (page dated 2026-07-09, read 2026-10-19, again 2026-10-26: terms unchanged, still V24).
- Download: `https://arch-center.azureedge.net/icons/Azure_Public_Service_Icons_V24.zip`.
- Terms, verbatim: "Microsoft permits the use of these icons in architectural diagrams, training materials, or documentation. You can copy, distribute, and display the icons only for the permitted use unless granted explicit permission by Microsoft. Microsoft reserves all other rights."
- Guidelines: "Don't crop, flip, or rotate icons." "Don't distort or change icon shape in any way." "Don't use Microsoft product icons to represent your product or service." "In diagrams, we recommend including the product name somewhere close to the icon."
- Reading: the icons are distributed inside Contura only so users can put them in architectural diagrams, the permitted use; the terms do not forbid that. This is the narrowest of the six; if Microsoft's terms tighten, this set is the first to recheck. Service tiles show the name under the icon, as the guideline recommends.
- Packed: every `NNNNN-icon-service-*.svg`, named `azure-<name>` with a leading `Azure-` dropped (`02390-icon-service-Azure-SQL.svg` is `azure-sql`). 80 files repeat a service in a second category folder; the first is kept. Aliases: `azure-vm`, `azure-aks`, `azure-storage`, `azure-functions`, `azure-cosmosdb`.

## Google Cloud icons

- Source: https://cloud.google.com/icons (read 2026-10-19, again 2026-10-26: wording unchanged). The page describes the library as "Official Google Cloud icons to build your own architectural diagrams or reference architectures." It links no separate licence; the footer links Google's site terms (https://policies.google.com/terms) and Google Cloud terms.
- Downloads: `https://services.google.com/fh/files/misc/core-products-icons.zip`, `.../google-cloud-legacy-icons.zip`, `.../category-icons.zip`. None of the zips holds a licence file.
- Reading: the stated purpose is building architecture diagrams, which is what Contura offers; nothing forbids bundling. Google Cloud and the product icons stay trademarks of Google LLC.
- Packed: the core product icons (`BigQuery-512-color.svg`), which take the legacy icon's name when one matches (`gcp-bigquery`, `gcp-cloud-sql`); the legacy console icons (`gcp-<folder name>`); and the category icons (`gcp-category-<name>`). 10 legacy icons are replaced by their current core icon.

## Kubernetes icons

- Source: https://github.com/kubernetes/community/tree/main/icons, README at commit 440e496d3a172234d81728df1bfe43849b589adf (read 2026-10-19); on 2026-10-26 the README text is unchanged and `main` is at commit a434040a92edf60f10a29879026845d0ed891c9a.
- Licence, verbatim: "The Kubernetes Icons Set is licensed under a choice of either Apache-2.0 or CC-BY-4.0 (Creative Commons Attribution 4.0 International). The Kubernetes logo is a registered trademark of The Linux Foundation, and use of it as a trademark is subject to The Linux Foundation's Trademark Usage Guidelines at https://www.linuxfoundation.org/trademark-usage/."
- We take CC-BY-4.0: attribution to the Kubernetes Authors with a link to the licence, shown in Icon credits; the icons are fitted into a frame (see "How icons are changed"), and Icon credits says so, as CC-BY-4.0 asks of a changed copy.
- Packed: `icons/svg/resources/unlabeled/*.svg` and `infrastructure_components/unlabeled/*.svg` as `k8s-<name>` (`k8s-pod`), and `control_plane_components/labeled/*.svg` (they come only labeled). Aliases spell out the short names: `k8s-deployment`, `k8s-service`, `k8s-ingress`, `k8s-configmap`, `k8s-statefulset`, `k8s-daemonset`, `k8s-replicaset`, `k8s-namespace`, `k8s-volume`, `k8s-persistentvolume`, `k8s-persistentvolumeclaim`, `k8s-serviceaccount`, `k8s-storageclass`, `k8s-endpoints`, `k8s-apiserver`, `k8s-scheduler`. All 39 icons and all 16 aliases are in the pack (the earlier count of 32 icons and 13 aliases counted the seven icons the allow list first refused); `k8s-cm` and the six control-plane icons pass through the allow list's narrow exceptions (see Safety check).

## Lucide

- Source: https://lucide.dev/license and the `LICENSE` file in `lucide-static` 1.61.0 (pinned) from the npm registry (first read 2026-10-19 against 1.59.0); read again 2026-10-26 against 1.61.0, same ISC and MIT text, copyright line unchanged.
- Licence: ISC, "Copyright (c) 2026 Lucide Icons and Contributors", which asks that the copyright notice and permission notice appear in all copies. The icons derived from Feather (listed in the file) are also under MIT, "Copyright (c) 2013-present Cole Bemis".
- Conditions met: the full `LICENSE` text travels in the pack as the set's notice and shows in Icon credits; each Lucide SVG also keeps its own `@license lucide-static ... ISC` comment, since the bytes before the root tag are copied unchanged.
- Packed: every `icons/*.svg`, unprefixed (`users`, `server`, `database`, `search`, `mail`). Lucide has no `queue` icon, so `queue` is an alias of `list-end`.
- Drawing: Lucide draws with `stroke="currentColor"` at stroke width 2. The pack sets the root `stroke-width` to 1.5 which matches Contura's own icons, and the Core serves the icon with the theme's text colour as `color`, so `currentColor` is that ink. A Lucide file with a `stroke-width` on any element other than the root is left out and listed; there are 0. Only the root tag changes; the drawing's bytes do not.

## Simple Icons

- Source: `simple-icons` 16.36.0 (pinned) from the npm registry: `LICENSE.md` (CC0 1.0 Universal), `DISCLAIMER.md`, and each icon's entry in `data/simple-icons.json`; https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md (read 2026-10-19); first read against 16.35.0, read again 2026-10-26 against 16.36.0, disclaimer and CC0 text unchanged.
- Licence: the project is CC0-1.0, but its disclaimer says: "Simple Icons is released under CC0 - though that doesn't mean to imply that all icons within the project are also CC0. Please see individual licenses where available."
- Trademark note: CC0 waives no trademark rights (CC0 section 4.1). Every logo is its brand's trademark and follows that brand's own guidelines; Contura shows a logo only to name that product in a diagram, fitted and inked but never redrawn, never as its own mark and never to suggest endorsement.
- Subset: all 3,466 brands pack to about 2.2 MB, which with the cloud sets and the framing passes the 4 MB cap, so the pack carries a tiered list, not every brand. `scripts/icon-brands.mjs` holds tiers of Simple Icons slugs (about 700 in all) and keeps every slug of the earlier 219. In: databases, languages and runtimes, cloud and hosting providers, queues and streams, CI/CD and source hosting, containers and orchestration, observability, auth and identity, API and protocol tools, web and backend frameworks, data and ML tools, developer tools and operating systems. Out: consumer, social, retail, media, automotive and finance brands, unless a developer integrates with them (Stripe, PayPal and Twilio are in). 759 brands are packed. If the pack goes over the cap, the newest tier is trimmed; the cap is never raised.
- Style: logos are one colour, drawn in the brand's own colour; below 1.5:1 on the canvas a logo gets a hairline in the text colour on light, or is drawn in the text colour on dark. The outline is drawn by the app around the image; the logo's file is not changed for it. The pack adds `fill="currentColor"` to the root when it has no `fill`.
- Colour: each logo's `hex` comes from Simple Icons' own data (`data/simple-icons.json`, CC0 like the rest of the project) and is stored on its index row as `#rrggbb`; a logo without a plain six digit colour would be left out and listed (there are 0). A brand colour is part of the brand's trademark, which CC0 does not touch: using it to name the product is the same use as the logo itself.
- Own licences: an icon whose entry names a licence ships only when that licence allows bundling it with credit (MIT, Apache-2.0, BSD, CC-BY, CC-BY-SA); the licence and its source travel with the icon (`IconEntry.licence`) and show in Icon credits. 78 logos carry one. These logos are now **fitted** (framed and inked, never redrawn), so each is an adapted copy: Icon credits says each set's change, and a share-alike logo is named as adapted below.
- **CC-BY-SA logos are adapted and shared under the same licence.** Debian (CC-BY-SA-3.0), Jenkins (CC-BY-SA-3.0), PHP (CC-BY-SA-4.0), R (CC-BY-SA-4.0), Ruby (CC-BY-SA-2.5) and Rust (CC-BY-SA-4.0) are kept. Because Contura fits and inks them, the adapted files are CC-BY-SA, shared under the same licence as the original. Icon credits says so beside each of them, using the licence the pack records for it (the same sentence is shown for any other logo whose own licence is CC-BY-SA). Left out: `keycloak` (custom), `letsencrypt` (CC-BY-NC-4.0), `vuedotjs` (CC-BY-NC-SA-4.0), `webpack` (custom).
- Named `brand-<slug>` (`brand-postgresql`).

## Oracle and Network (2026-10-26)

Two further sets were checked and fail the check for 1.0. Both are left out of 1.0, with their chips; the Icons tab's Cloud row is built from the sets present in the pack, so a set that passes a later check appears without UI work. The names `oci-` and `net-` stay reserved.

- **Oracle (OCI).** https://docs.oracle.com/en-us/iaas/Content/General/Reference/graphicsfordiagrams.htm (read 2026-10-26). The page offers "the Oracle Cloud Infrastructure (OCI) Architecture Diagram Toolkit in three formats: PowerPoint, draw.io, Visio". No SVG, and no terms of use on the page. Its Legal Notices (https://docs.oracle.com/iaas/Content/legalnotices.htm) grant nothing for the icons and say: "Except as expressly permitted in your license agreement or allowed by law, you may not use, copy, reproduce, translate, broadcast, modify, license, transmit, distribute, exhibit, perform, publish, or display any part, in any form, or by any means."
- **Network (Cisco network topology icons, which Eraser's "Networking" set is).** https://www.cisco.com/c/en/us/about/brand-center/network-topology-icons.html (read 2026-10-26; the page refused plain `curl` with 403, so it was read through a page fetch). It says "You may use them freely, but you may not alter them." It offers EPS, JPG, Visio stencils, a PowerPoint library and a PDF reference, no SVG, and says nothing about redistribution or use inside software. Making SVGs would mean converting (altering) the files and running converters over untrusted downloads, and fitting them would alter them again.
- **Verdict:** left out of 1.0, with their chips. Neither page now offers SVGs under written terms that allow use in diagrams and bundling. Revisit if either vendor publishes SVGs with such terms.

## Safety check

The downloads are untrusted data. They were fetched into a new empty folder outside the repo (the session scratchpad's `icons-src`), extracted there, and only read by `scripts/pack-icons.mjs`; nothing in them was run. Only `icons.bin` is committed.

An SVG goes into the pack only if it passes an allow list. Everything not listed is refused, so a name nobody thought of cannot get through:

- under 256 KB, valid UTF-8, and no character below U+0020 except tab, LF and CR (so no NUL, which also stops BOM-less UTF-16);
- markup: only an optional `<?xml version=... encoding="UTF-8" standalone=...?>` at the start, comments, elements and text; no DOCTYPE, ENTITY, CDATA or other processing instruction; text may use only the five predefined entities (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`), so no `&#` reference;
- elements, full name with any prefix: svg, g, path, rect, circle, ellipse, line, polyline, polygon, defs, symbol, use, title, desc, metadata, linearGradient, radialGradient, stop, clipPath, mask, pattern, style, text, tspan, filter and the fe* primitives except feImage; plus the metadata elements the Kubernetes files carry: sodipodi:namedview, rdf:RDF, cc:Work, dc:format, dc:type, dc:title; and `a` (unprefixed) only as a plain group: an `a` with `href`, `xlink:href` or any `*:href` attribute is refused as an element, and its other attributes must be on the attribute list;
- attributes, each on a list: geometry and presentation attributes (value must pass the style rule), `transform` and `gradientTransform` (style rule plus translate, scale, rotate, matrix, skewX, skewY), names and notes that no browser reads as a link or style (id, class, data-name, role, version and the listed inkscape:/sodipodi: metadata; any text, entities checked), `type` only as `text/css` except on feColorMatrix, where it must be `matrix`, `saturate`, `hueRotate` or `luminanceToAlpha`, `rdf:resource` only as the Dublin Core StillImage URI, `href`/`xlink:href` only as `#id`, and `xmlns`/`xmlns:svg|xlink|dc|cc|rdf|sodipodi|inkscape` only with their one namespace URI;
- style (style sheets, style attributes and presentation values): only `A-Z a-z 0-9 space # . , : ; % ( ) _ + - LF tab` (style sheets also `{ }`, which a style sheet needs and which cannot carry a link or escape), so no quotes, backslash, `@` or `/*`; the only functions are `url(#id)`, `rgb()`, `rgba()`, `hsl()`, `hsla()`. One exception for quotes, in a style attribute or inside a rule of a style sheet (never in a presentation value): a declaration whose property starts with `-inkscape-` may have as its whole value one single- or double-quoted string of `A-Z a-z 0-9 space , . -`, followed only by spaces and then `;`, `}` or the end. The string is checked before the rest, so it cannot hold a backslash, another quote, a parenthesis, `:` or `;`, and cannot hide a second declaration or a `url(`; a browser ignores `-inkscape-*` properties.

The rule is written twice, step for step: `scripts/svg-check.mjs` (used by the pack script) and the Core's `icons::unsafe_reason`, which also checks each icon again as it is served (a refused icon answers not found and is logged). Both are tested against one fixture list, `crates/contura-core/tests/fixtures/svg-check.json`, which holds every bypass found in review, and must give the same reason. The UI shows icons only as an `<img>` with a `data:` URL, never as markup.

Icons the allow list leaves out: none (AWS 0, Azure 0, Google Cloud 0, Kubernetes 0, Lucide 0, Simple Icons 0).

The three exceptions above were added for nine icons the list first refused (see Decisions below): `gcp-my-cloud` and `gcp-security-health-advisor` (`type="matrix"` on feColorMatrix); `k8s-cm` (paths wrapped in `<a id="...">` with no link); and the six control-plane icons `k8s-api`, `k8s-c-c-m`, `k8s-c-m`, `k8s-k-proxy`, `k8s-kubelet` and `k8s-sched` (`-inkscape-font-specification:'Arial, Normal'` in a text `style`). With them the aliases `k8s-configmap`, `k8s-apiserver` and `k8s-scheduler` are back. (At that time the pack held 4,069 names in 2,650,070 bytes; see the summary for today's.) The fixture list holds the real shapes as kept and the abuse attempts (`type` on other elements or with other values; a `-inkscape-` string with `url(`, a backslash, an escaped quote, `;` or `:`, or followed by a second declaration; quotes on any other property; `<a>` with a link, `onclick` or `target`) as refused.

## Drawing check

`tests/icons.rs` `icon_drawing_unchanged` compares the SHA-256 of everything after the root tag of the icons served by the Core with the same part of the source files (`PACK_SAMPLES=... node scripts/pack-icons.mjs` prints each `drawing-sha256`). Framing rewrites only the root start tag, so these hashes prove the drawing is unchanged.

| Name | Source file | SHA-256 of the drawing |
|---|---|---|
| aws-s3 | Arch_Amazon-Simple-Storage-Service_64.svg | e01b528707016d1c6ef7769f0e76d09f5d05c45c22bc20b04ea659ae04c0de4a |
| azure-sql | 02390-icon-service-Azure-SQL.svg | 7da1b549a517ce48bfde8f1edf96d92cd0bc7de44f0cca7602c8a040a54c33d7 |
| gcp-bigquery | BigQuery-512-color.svg | 78124fab77ee4b99dcad021db9965418f223919c9deb5c43f722d2eb8ac8da13 |
| k8s-pod | resources/unlabeled/pod.svg | 8831794d1cf190b6dc6b7026960819abf6b5561591714b109eadab340527bd26 |
| database | lucide icons/database.svg | 9c1e025c9c894f5da40d2ed298c2e0d3dfa54b5e0981ab0dcedc4b9c8c7c5222 |
| brand-postgresql | simple-icons icons/postgresql.svg | 62c64a9c7f56a01450dbc67246f92b22ecd328c7ef5bff958b5f8cf92edfcd24 |

## Rebuilding the pack

1. Make a new empty folder outside the repo and download into it: the AWS package zip, the Azure V24 zip, the three Google zips, the `lucide-static` 1.61.0 and `simple-icons` 16.36.0 npm tarballs (from `registry.npmjs.org`, not `npm install`, so no package script runs), and `icons/svg` of kubernetes/community at one commit. The pinned versions are the ones named in this file; if a cloud vendor has published a newer release than the one recorded here, take it and record it.
2. Extract them as `aws/`, `azure/`, `gcp-core/`, `gcp-legacy/`, `gcp-category/`, `lucide/`, `simple/`, and `k8s/icons/svg/`.
3. Re-read each set's terms and update this file.
4. `node scripts/pack-icons.mjs <that folder> [out file] [--previous <pack>] [--sheet <file.html>]`. It prints each set's counts, bytes and the headroom, and refuses a pack of 4 MB or more.
   - `--previous <pack>` is the stability gate: the script reads that pack (by default the committed `icons.bin`) and fails if any of its names is missing from the new one. A name that moved goes in `RENAMED` (old name to new name; the old name becomes an alias), and a name upstream removed with no replacement goes in `DROPPED` (old name to a one line reason). Both are in the script, both are printed, and both are empty today.
   - `--sheet <file.html>` writes a contact sheet of every icon in light and dark, to check each set's `PAD` by eye.
   - `PACK_SAMPLES=aws-s3,azure-sql,...` prints each named icon's `drawing-sha256`.
5. Update the hashes in `tests/icons.rs` if the sample files changed.

## Decisions (2026-10-19)

1. **AWS, Azure and Google Cloud icons stay.** Shipping them in a diagramming tool is read as the use their terms allow ("to create architecture diagrams"), Azure included.
2. **The six CC-BY-SA brand logos stay** (Debian, Jenkins, PHP, R, Ruby, Rust), credited in Icon credits.
3. **All brand logos stay.** They name products in diagrams; their trademarks are not licensed by CC0.
4. **The nine icons the safety check left out go into the pack** (seven Kubernetes, two Google Cloud), through three narrow allow-list exceptions (feColorMatrix type values; quoted plain values only inside -inkscape-* style properties; an <a> element with no link attribute). See "Safety check".

2026-10-26: the six CC-BY-SA logos (Debian, Jenkins, PHP, R, Ruby, Rust) are kept and fitted, and the credits and these notes say plainly that the adapted files are CC-BY-SA, shared under the same licence. Oracle and Network failed the check above and are left out.
