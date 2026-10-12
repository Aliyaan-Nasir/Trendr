# Third-party assets

Images and logos in `public/` that come from someone else, where each came from, and the terms that allow its use here.
Keep this list current when an asset is added or replaced.

## Photos

| File | Source | Licence |
| --- | --- | --- |
| `public/assets/img/topics-cells.jpg` | Unsplash, `images.unsplash.com/photo-1576086213369-97a306d36557` (fluorescent cell micrograph), resized to 2000 px | [Unsplash License](https://unsplash.com/license): free for commercial use, no attribution required |
| `public/assets/img/crypto-chart.jpg` | Unsplash, `images.unsplash.com/photo-1640340434855-6084b1f4901c` (trading chart on a screen), resized to 2000 px | [Unsplash License](https://unsplash.com/license): free for commercial use, no attribution required |

These two were hotlinked from the Unsplash CDN before and are now served locally.
The Unsplash photo pages could not be resolved from the CDN ids, so the photographers are not credited by name; the licence does not require it.

## Generated images

Made for Trendr with Higgsfield (Nano Banana 2.1) on the owner's paid Starter plan.

| File | Where it is used |
| --- | --- |
| `public/assets/img/topics-islands.jpg` | About slider, first slide (made with Nano Banana Pro; replaced `topics-tiles.jpg`, which replaced `topics-cells.jpg`; both stay on disk) |
| `public/assets/img/topics-wave.jpg` | "Topics trend every day" card, desktop and mobile (replaced `topics-trend-every-day.png` there; the case study slider still uses it) |
| `public/assets/img/rising-chart.jpg` | "Each Winning Token Pays 1 AUSD" card in the stats section, desktop and mobile (replaced `monad-markets.jpg`) |
| `public/assets/img/no-gas-cat.jpg` | "No Gas to Pay" card in the stats section, desktop and mobile (replaced `elfa-ai-auto.jpg`) |
| `public/assets/img/launch-thumbnails.jpg` | Launch section background, desktop and mobile (made with GPT Image 2.5 Sunburst on Higgsfield; replaced `ai-thumbnails.png` there, which the "Four Ways to Trade" card still uses) |
| `src/app/opengraph-image.jpg`, `src/app/twitter-image.jpg` | Link preview when trendr.bid is shared, with the logo and headline added |
| `design/trendr-x-banner-1500x500.jpg` | X profile banner (not served by the site) |

The images they replaced stay on disk to switch back: `topics-cells.jpg`, `topics-trend-every-day.png`, `monad-markets.jpg` and `elfa-ai-auto.jpg` in `public/assets/img/`, and the plain share image in `design/originals/share-image-plain.png`.

## Partner logos

Logos are used unmodified, only to say which services Trendr uses, with no claim of endorsement.
SVGs were checked for scripts, event handlers and external references, and stripped of comments and metadata only.

| File | Where it is used | Source | Terms that allow it |
| --- | --- | --- | --- |
| `public/assets/logos/monad.svg` | Signal card | [Monad brand and media kit](https://www.monad.xyz/brand-and-media-kit) (inverted horizontal lockup) | Public brand kit and its guidelines: no alteration, clear space of one logomark, inverted set on dark surfaces |
| `public/assets/logos/nansen.svg` | Signal card | [Nansen brand page](https://www.nansen.ai/brand) (green and white wordmark) | [Nansen API terms](https://www.nansen.ai/legal/api) ask for "Powered by Nansen" or "Data provided by Nansen" attribution with the logo or name |
| `public/assets/logos/wikipedia-wordmark.svg` | Signal card, linked to wikipedia.org | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Wikipedia-wordmark-en_(white).svg), public domain artwork | [Wikimedia trademark policy](https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_Trademark_Policy): logos may be used unmodified as a link to a Wikimedia site; the terms page carries the trademark notice |
| `public/assets/logos/elfa.svg` | Signal card | The lockup on [elfa.ai](https://www.elfa.ai) (Elfa publishes no brand kit) | Elfa's terms require written permission to use its marks; the site already showed Elfa's logo, so the owner should confirm that permission |
| `public/assets/logos/bluesky.svg` | Signal card, Social mentions tile beside Elfa | [Bluesky brand assets](https://bsky.social/about/support/icons) (full logo, blue) | [Bluesky brand guidelines](https://bsky.social/about/support/branding): official files unaltered, the blue logo on light backgrounds, clear space of one butterfly on every side |
| `public/assets/logos/coingecko.svg` | Signal card, Trending lists tile, linked to coingecko.com | [CoinGecko brand kit](https://brand.coingecko.com/resources/brand-kit) (lockup for dark backgrounds) | [CoinGecko attribution guide](https://brand.coingecko.com/resources/attribution-guide): official logos, linked to its site, with no claim of endorsement |
| `public/assets/logos/geckoterminal.svg` | Signal card, Trending lists tile, linked to geckoterminal.com | [CoinGecko brand kit](https://brand.coingecko.com/resources/brand-kit) (GeckoTerminal lockup for dark backgrounds) | Same attribution guide as CoinGecko |
| `public/assets/img/chainlink-oracle.jpg` | Signal card, Oracle tile | Chainlink artwork supplied by the owner, extended top and bottom with a blurred fill so the logo shows at any tile shape | Chainlink's trademark terms ask for written permission to use its marks, so the owner should confirm that permission |

Hacker News appears on the Trending lists tile as its name on an orange badge, linked to its site, not as Y Combinator's logo.

The hero video (`public/assets/video/hero-vid.mp4`) was re-rendered so its "Powered by" frame shows two rows of brand tiles: Built on (Monad, Chainlink, Kuru, Perpl, AUSD, Aurora) and Data from (Elfa, Nansen, CoinGecko, Wikipedia), the second row arriving just after the first within the original timing.
Each mark sits on its brand's own tile colour, as in its official avatar: Monad Purple `#6E54FF` and Perpl `#6F5CFF` with white marks, Chainlink's blue `#0847F7` with its white hexagon, Kuru's green avatar, Agora's mark for AUSD on near-black, Aurora Black `#101820` with the green token mark (Aurora's dark-background token), Nansen's dark navy `#071019` with its green icon, the CoinGecko symbol from its brand kit, and the Wikipedia "W" from the wordmark above.
Perpl's mark comes from its [brand kit](https://aionex.notion.site/perpl-brand-kit) ("Use these to represent Perpl accurately"), Aurora's from its [press kit](https://brand.aurora.dev/) and CoinGecko's from its [brand kit](https://brand.coingecko.com/resources/brand-kit).
