# Pokémon GO Friend Dex Tracker

A no-login web app for tracking Pokémon GO collections for yourself and your friends. Every trainer
gets eight Pokédex pages — **Original, Shiny, Lucky, XXL, XXS, Shadow, Purified and 100%** — covering
every Pokémon, regional form and costume Pokémon, plus a **Trade Wishlist** with P0/P1/P2
priorities. Progress is shared with a live link that keeps friends up to date, or by sending a
file, similar to [Leek Duck's Shiny Checklist](https://leekduck.com/shiny/).

## Using it

**Live site: https://audreyhou.github.io/PokemonGoFriendDexTracker/**

You can also open `index.html` in a browser (double-clicking it works) or host the folder on any
other static host. The live site is published by GitHub Pages from the root of the `main` branch.

- **Trainers** – choose **+ New** and enter a username. Switch between trainers with the
  *Trainer* dropdown; each trainer has a separate set of all eight Pokédexes and their own
  wishlist. There is no account or login — everything is saved in the browser's local storage.
  The dropdown lists your own trainers under **My trainers** and friends' trainers under
  **Friends**, and the line under the progress bar says *Your trainer* or *Friend*.
- **Checking off Pokémon** – click (or tap) a Pokémon image to mark it as owned in the current tab.
  Missing Pokémon are greyed out. To mark many at once, click one Pokémon and then
  <kbd>Shift</kbd>+click another: every Pokémon shown between them gets the same checked or
  unchecked state as the first one. The **Select all** toggle next to each generation's title
  checks every Pokémon shown in that generation (or unchecks them all once they are all checked).
- **Card size** – the **−** / **+** buttons at the end of the filter bar make the Pokémon cards
  smaller or bigger (60%–200%) on every dex page; click the percentage to go back to 100%. The size
  is remembered in this browser.
- **Tabs** – each Pokédex is its own page (`#original`, `#shiny`, `#lucky`, `#xxl`, `#xxs`,
  `#shadow`, `#purified`, `#perfect`, `#wishlist`). The Shiny tab shows shiny artwork. Shadow and
  Purified only list Pokémon released as Shadow Pokémon, and Lucky and Wishlist leave out Mythical
  Pokémon that cannot be traded.
- **Trade Wishlist** – mark the Pokémon you want to receive in trades. Each click moves a Pokémon
  to the next mark: not marked → **P0** (most wanted) → **P1** → **P2** → **Do not trade** → not
  marked. *Do not trade* is for Pokémon you actively don't want friends to send you; they don't
  count as wanted. <kbd>Shift</kbd>+click gives a range the first Pokémon's mark. On this tab the
  caught filter is replaced by a priority filter (any priority, P0, P1, P2, Do not trade or not
  marked). **Add missing Luckies as P2** adds every released Pokémon missing from your Lucky
  Pokédex to the wishlist as P2, so you only need to adjust the rest; Pokémon already on the
  wishlist, including ones marked *Do not trade*, keep their mark. The wishlist is included in
  share links and exported files, so friends can see what you are looking for.
- **Filters** – search by name or number, filter by generation, caught/missing, or regular forms
  vs. costumes. *Include evolution line* (on by default) only changes search results: a search also
  shows the rest of the searched Pokémon's evolution family (e.g. "pikachu" also shows Pichu and
  Raichu); untick it to see only the Pokémon whose name or number matches. Pokémon not yet released
  in Pokémon GO are hidden unless *Include unreleased* is checked.

### Sharing with friends by link

1. Select your trainer and choose **Share link → Create link**, then copy the link (or use
   **Share…** on phones) and send it to friends.
2. When a friend opens the link, your trainer is added to their *Trainer* dropdown under
   **Friends**, marked **· live link**. If they already have a trainer with that name, they are asked
   before it is replaced.
3. Every change you make is sent automatically a moment later, and friends who have the tracker
   open see it within a few seconds (otherwise the next time they open it). The status under the
   progress bar shows whether your changes have been shared.

Friends' trainers are read-only. **Remove** deletes a friend's trainer from your browser only; their
Pokédex and link keep working, and opening the link again adds them back. Your own shared trainers
are marked **· shared** in the dropdown. **Share link → Stop sharing** turns your link off: friends
keep their last copy but stop getting updates. Anyone with the link can view the Pokédex.

#### Using your trainer in another browser

Only the browser that created a link can change the shared trainer. To edit it from another phone
or computer, open **Share link → Use this trainer in another browser**, copy the private sync link
and open it there. Both browsers can then make changes and stay in sync. Keep the sync link
private: anyone with it can change your Pokédex. Copies of a trainer in exported files never
contain the sync key.

### Sharing with friends by file

1. Select your trainer and choose **Export file**. This downloads
   `friend-dex-<username>-<date>.json`. (**Export all** saves every trainer in one file.)
2. Send the file to a friend however you like (chat, email, cloud drive…).
3. Your friend chooses **Import file** (or drags the file onto the page) and marks the trainer as
   **A friend's**. The trainer appears under *Friends* in their *Trainer* dropdown. Importing a
   trainer that already exists asks before replacing it, so re-importing a newer file from the same
   friend updates their Pokédex.

The same files work as backups or to move your progress to another device: when importing, mark
your trainers as **Mine (backup)**. Whether a trainer is yours or a friend's is never stored in
the file, so the person importing always chooses. Only your own trainers can be shared by link.

#### File format

```json
{
  "app": "pokemon-go-friend-dex",
  "version": 1,
  "exportedAt": "2026-11-15T22:30:00.000Z",
  "users": [
    {
      "username": "Ash",
      "updatedAt": "2026-11-15T22:29:41.000Z",
      "dex": { "original": ["f87", "c0025Holiday2016"], "shiny": [], "lucky": [], "xxl": [],
               "xxs": [], "shadow": [], "purified": [], "perfect": [],
               "wishlist": { "p0": ["f13"], "p1": [], "p2": ["c0025Holiday2016"], "doNotTrade": ["f19"] } }
    }
  ]
}
```

Entry ids are stable: `f<id>` is a [pokemon.gameinfo.io](https://pokemon.gameinfo.io/) form id and
`c<dex><code>` is a costume, named after its Bulbapedia image (e.g. `c0025Holiday2016` for
`GO0025Holiday2016.png`). Unknown ids in imported files are kept, so files made with newer data
are not damaged. Files without a `wishlist` (made before it existed) import with an empty wishlist.

## Pokédex data

`data/dex.js` is generated by `scripts/build_dex.py` (Python 3.8+, standard library only) from:

- [pokemon.gameinfo.io](https://pokemon.gameinfo.io/) – every species and form, evolution
  families, Shadow availability, release status, and Pokémon images (regular and shiny).
- [Bulbapedia – Event Pokémon (GO)](https://bulbapedia.bulbagarden.net/wiki/Event_Pok%C3%A9mon_(GO))
  – every released costume Pokémon and its image. Shiny costume images use Bulbapedia's `_s`
  files and fall back to the regular image when no shiny exists.

gameinfo also lists some costumes; the script matches those to Bulbapedia's entries (by name, with
a few hand-verified overrides in `MANUAL_MATCHES`) so each costume appears once. Mega and Primal
forms are not separate entries. Spinda is listed as Patterns #1–#9 like in Pokémon GO; gameinfo's
extra Spinda forms only reuse Pattern #1's image and are skipped (raise `SPINDA_PATTERNS` if new
patterns are released).

To refresh the data:

```sh
python scripts/build_dex.py            # add --report to print the costume matching details
```

Bulbapedia blocks most scripted requests, so the script falls back to the latest Wayback Machine
snapshot of the page. If that is unavailable or rate-limited, save the Bulbapedia page from your
browser (*Save page as → Webpage, HTML only*) and run:

```sh
python scripts/build_dex.py --bulbapedia-html path/to/Event_Pokemon_GO.html
```

After a refresh, check the `unmatchedGameinfo` list from `--report`: any costume listed there would
appear twice and needs an entry in `MANUAL_MATCHES`.

Images are loaded directly from pokemon.gameinfo.io and archives.bulbagarden.net, so the tracker
needs an internet connection to show them.

## Share link server

Share links are stored by a small Azure Functions app in `api/` (Node.js 22, Flex Consumption)
that uses Azure Table Storage for the shared trainers and Azure Web PubSub (Free tier) to tell open
trackers about changes. The site calls it at the `apiBase` in `js/config.js`; set it to `''` to
hide share links. Without Web PubSub, trackers fall back to checking for changes every minute.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/shares` | Create a link; returns its id and the owner key. |
| `GET /api/shares/{id}` | Read a shared trainer (anyone with the link). |
| `PUT /api/shares/{id}` | Update it (`Authorization: Bearer <owner key>`). Older copies are rejected with 409. |
| `DELETE /api/shares/{id}` | Turn the link off (owner key). |
| `POST /api/shares/{id}/verify` | Check an owner key from a sync link. |
| `GET /api/negotiate?ids=a,b` | WebSocket URL that receives `{ type, id }` messages for those links. |

Only a SHA-256 hash of each owner key is stored. The Function App signs in to Storage and Web
PubSub with its managed identity (roles *Storage Table Data Contributor* on the `trainers` table and
*Web PubSub Service Owner*), so no account keys are kept in its settings. It needs these app
settings: `STORAGE_ACCOUNT_NAME`, `WEBPUBSUB_ENDPOINT`, `TABLE_NAME` (`trainers`) and `PUBSUB_HUB`
(`dex`), plus CORS for `https://audreyhou.github.io`. For local development,
`STORAGE_CONNECTION_STRING` and `WEBPUBSUB_CONNECTION_STRING` can be used instead.

Each client IP may create 10 links an hour, make 60 changes a minute and 300 reads a minute (per
Function App instance); beyond that the API answers 429. The site's Content Security Policy only
allows its own scripts and connections to this API and Web PubSub.

GitHub Actions deploys the API automatically (`.github/workflows/deploy-api.yml`) whenever `api/`
changes on `main`, after running its tests; `.github/workflows/ci.yml` runs all tests on pull
requests. The deploy signs in to Azure with OpenID Connect, using the repository variables
`AZURE_CLIENT_ID`, `AZURE_TENANT_ID` and `AZURE_SUBSCRIPTION_ID` of an app registration that has a
federated credential for `repo:audreyhou/PokemonGoFriendDexTracker:ref:refs/heads/main` and the
Contributor role on the Function App. It can also be started by hand from the Actions tab.

To deploy the API by hand from [Azure Cloud Shell](https://shell.azure.com):

```sh
git clone https://github.com/audreyhou/PokemonGoFriendDexTracker.git
cd PokemonGoFriendDexTracker/api
npm ci --omit=dev
zip -qr ../api.zip . -x "test/*"
az functionapp deployment source config-zip -g rg-friend-dex -n friend-dex-api-52212 --src ../api.zip
```

## Development

```sh
python -m unittest discover -s tests
cd api && npm ci && npm test
```

## Credits

Pokédex data and images: [pokemon.gameinfo.io](https://pokemon.gameinfo.io/). Costume Pokémon data
and images: [Bulbapedia](https://bulbapedia.bulbagarden.net/). This is a fan-made tool and is not
affiliated with Niantic, Nintendo, Creatures or GAME FREAK. Pokémon and its characters are
trademarks of Nintendo.
