#!/usr/bin/env python3
"""Build data/dex.js for the Pokémon GO Friend Dex Tracker.

Sources
  * https://pokemon.gameinfo.io/ - the full Pokédex (every species and form) and its images.
  * https://bulbapedia.bulbagarden.net/wiki/Event_Pok%C3%A9mon_(GO) - every released costume
    Pokémon and its image.

Bulbapedia blocks most non-browser clients, so when the direct request fails the page is read
from the latest Wayback Machine snapshot instead. A copy saved from a browser can be supplied
with --bulbapedia-html.

Usage:  python scripts/build_dex.py [--bulbapedia-html PATH] [--report]
"""
from __future__ import annotations

import argparse
import datetime
import gzip
import hashlib
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "data" / "dex.js"

GAMEINFO = "https://pokemon.gameinfo.io"
GAMEINFO_DATA = GAMEINFO + "/en/js/pokemon.json"
GAMEINFO_FAMILIES = GAMEINFO + "/en/js/pokemon-home.json"
BULBA_PAGE = "https://bulbapedia.bulbagarden.net/wiki/Event_Pok%C3%A9mon_(GO)"
BULBA_MEDIA = "https://archives.bulbagarden.net/media/upload"
WAYBACK_LOOKUP = "https://archive.org/wayback/available?url="
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)

# Unlisted gameinfo forms that are distinct, collectible Pokédex entries (Unown letters, Spinda).
FORM_VARIANT_SPECIES = {201, 327}
# gameinfo numbers Spinda forms from 00 like the game files, so its "Spinda" is Pattern #1 and
# "Spinda (01)" is Pattern #2. Forms past the last pattern in Pokémon GO reuse Pattern #1's image
# as a placeholder and are skipped.
SPINDA_PATTERNS = 9
# Unlisted gameinfo forms that look identical in GO and are not tracked (Scatterbug/Spewpa patterns).
HIDDEN_VARIANT_SPECIES = {664, 665}
# Listed gameinfo forms that Bulbapedia's event list treats as costumes.
LISTED_COSTUME_FORMS = {
    85,  # Armored Mewtwo
    387, 541, 542, 769,  # Cosplay Pikachu (Libre, Pop Star, Rock Star, Ph.D.)
    419, 539, 666, 687, 688, 770, 771,  # Flying Pikachu balloons
    778,  # Pikachu (Cap's Hat), i.e. Captain Pikachu
    1581,  # Corsola (Pink Sunglasses)
}
# gameinfo form id -> Bulbapedia image file, for costumes whose names are ambiguous or share no
# words. Verified by comparing the two sites' images.
MANUAL_MATCHES = {
    387: "GO0025Li.png",
    541: "GO0025Po.png",
    542: "GO0025Ro.png",
    769: "GO0025PhD.png",
    419: "GO0025Fly.png",
    539: "GO0025Fly5.png",
    778: "GO0025Captain.png",
    465: "GO0094Costume2020.png",  # Gengar (Halloween 2020) = Mega Banette costume
    1569: "GO0025WCS2025.png",
    1624: "GO0025WCS2026.png",
    1591: "GO0999Anniversary9.png",
    1632: "GO0999Anniversary10.png",
    1626: "GO0025Anniversary2026Malaysia01.png",  # PokéXciting! Turquoise
    1627: "GO0025Anniversary2026Singapore01.png",  # PokéXciting! Blue
    1628: "GO0025Anniversary2026Taiwan01.png",  # PokéXciting! Pink
    1629: "GO0025Anniversary2026Philippine01.png",  # PokéXciting! Red
    1662: "GO0854Bow.png",  # Phony Sinistea
    1663: "GO0854ABow.png",  # Antique Sinistea
    1664: "GO0855Bow.png",
    1665: "GO0855ABow.png",
}
# Readable labels for Bulbapedia costumes that share a name and have no gameinfo counterpart.
FILE_LABELS = {
    "GO0025O.png": "Original Cap", "GO0026O.png": "Original Cap", "GO0172O.png": "Original Cap",
    "GO0025W.png": "World Cap", "GO0026W.png": "World Cap",
    "GO0710SmHalloween2022.png": "Spooky Festival – Small", "GO0711SmHalloween2022.png": "Spooky Festival – Small",
    "GO0710Halloween2022.png": "Spooky Festival – Average", "GO0711Halloween2022.png": "Spooky Festival – Average",
    "GO0710LaHalloween2022.png": "Spooky Festival – Large", "GO0711LaHalloween2022.png": "Spooky Festival – Large",
    "GO0710SuHalloween2022.png": "Spooky Festival – Super", "GO0711SuHalloween2022.png": "Spooky Festival – Super",
}
# Mythical Pokémon that can be traded (and therefore be lucky).
TRADEABLE_MYTHICALS = {808, 809}  # Meltan, Melmetal
STOPWORDS = {"a", "an", "the", "with", "wearing", "and", "of", "form", "go", "png", "s", "costume"}


# --------------------------------------------------------------------------- fetching

def fetch(url: str, attempts: int = 4) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept-Encoding": "gzip"})
    for attempt in range(1, attempts + 1):
        try:
            with urllib.request.urlopen(req, timeout=90) as resp:
                data = resp.read()
            break
        except urllib.error.HTTPError as err:
            if err.code not in (429, 500, 502, 503, 504) or attempt == attempts:
                raise
            delay = int(err.headers.get("Retry-After") or 0) or 15 * attempt
            print(f"HTTP {err.code} from {url}; retrying in {delay}s", file=sys.stderr)
            time.sleep(delay)
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    return data.decode("utf-8", "replace")


def parse_gameinfo(text: str):
    """gameinfo prefixes its JSON with an anti-hijacking guard (";for(;;);")."""
    start = min(i for i in (text.find("{"), text.find("[")) if i >= 0)
    data, _ = json.JSONDecoder().raw_decode(text[start:])
    return data


def parse_families(home: list) -> list[list[int]]:
    """Evolution families as lists of National Dex numbers, from gameinfo's pokemon-home.json.

    Each family is a list of stages; each stage maps dex number -> details. Regional lines
    (e.g. Galarian Meowth -> Perrserker) are separate families that share a dex number.
    """
    families = []
    for family in home:
        dexes = []
        for stage in family:
            dexes += [int(dex) for dex in stage if int(dex) not in dexes]
        families.append(dexes)
    return families


def load_bulbapedia(saved_html: str | None) -> tuple[str, str]:
    if saved_html:
        return Path(saved_html).read_text(encoding="utf-8"), "file:" + saved_html
    try:
        return fetch(BULBA_PAGE), BULBA_PAGE
    except urllib.error.HTTPError as err:
        print(f"Bulbapedia returned HTTP {err.code}; using the Wayback Machine snapshot", file=sys.stderr)
    lookup = json.loads(fetch(WAYBACK_LOOKUP + urllib.parse.quote(BULBA_PAGE, safe="")))
    snap = lookup.get("archived_snapshots", {}).get("closest")
    if not snap:
        raise SystemExit("No Wayback Machine snapshot of the Bulbapedia page is available")
    raw_url = re.sub(r"/web/(\d+)/", r"/web/\1id_/", snap["url"]).replace("http:", "https:", 1)
    return fetch(raw_url), raw_url


# --------------------------------------------------------------------------- bulbapedia

def strip_tags(fragment: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def image_file(src: str) -> str:
    """Return the original file name for a (possibly thumbnailed) Bulbagarden image URL."""
    parts = src.split("/")
    name = parts[-2] if "/thumb/" in src else parts[-1]
    return urllib.parse.unquote(name)


def bulba_url(file_name: str, width: int | None = 120) -> str:
    """MediaWiki stores uploads under md5-derived directories."""
    name = file_name.replace(" ", "_")
    digest = hashlib.md5(name.encode("utf-8")).hexdigest()
    quoted = urllib.parse.quote(name)
    if width:
        return f"{BULBA_MEDIA}/thumb/{digest[0]}/{digest[:2]}/{quoted}/{width}px-{quoted}"
    return f"{BULBA_MEDIA}/{digest[0]}/{digest[:2]}/{quoted}"


def shiny_file(file_name: str) -> str:
    stem, _, ext = file_name.rpartition(".")
    return f"{stem}_s.{ext}"


def parse_event_table(page: str) -> list[dict]:
    """Parse the costume table of Bulbapedia's "Event Pokémon (GO)" page.

    Returns one dict per costume Pokémon image, in table order. The first column (costume name)
    uses rowspan, so rows with three cells inherit the previous costume name.
    """
    start = page.find('id="List_of_Event_Pok')
    if start < 0:
        raise ValueError("Could not find the 'List of Event Pokémon' section")
    end = page.find('id="Trivia"', start)
    table = re.search(r"<table.*?</table>", page[start:end if end > 0 else None], re.S)
    if not table:
        raise ValueError("Could not find the event Pokémon table")

    link_re = re.compile(r'<a href="([^"]+)" title="([^"]+)"><img[^>]*?src="([^"]+)"')
    costumes, seen, form = [], set(), None
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table.group(0), re.S)[1:]:
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)
        if len(cells) == 4:
            form, cells = strip_tags(cells[0]), cells[1:]
        if len(cells) != 3 or form is None:
            continue
        avail_items = re.findall(r"<li>(.*?)</li>", cells[2], re.S)
        # The first availability item may contain a nested list of details; keep only its headline.
        note = strip_tags(avail_items[0].split("<ul")[0]) if avail_items else strip_tags(cells[2])
        note = note.split("\n")[0].strip()
        members = [(m, False) for m in link_re.findall(cells[0])] + [(m, True) for m in link_re.findall(cells[1])]
        shadow = any(image_file(src).startswith("GO_Shadow") for (_, _, src), _ in members)
        for (_, title, src), evo_only in members:
            file_name = image_file(src)
            match = re.match(r"GO(\d{4})(.+)\.png$", file_name)
            # Skips icons (e.g. the shadow marker) and bare "GO0025.png" placeholders used for
            # announced costumes that have no artwork yet.
            if not match or file_name in seen:
                continue
            seen.add(file_name)
            costumes.append({
                "dex": int(match.group(1)),
                "species": html.unescape(title),
                "form": form,
                "file": file_name,
                "code": match.group(2),
                "evoOnly": evo_only,
                "shadow": shadow,
                "note": note,
            })
    return costumes


# --------------------------------------------------------------------------- matching

def tokens(text: str) -> set[str]:
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    text = re.sub(r"([A-Za-z])(\d)", r"\1 \2", text)
    text = text.replace("’", "'").replace("'s", "").lower().replace("é", "e")
    return {w for w in re.split(r"[^a-z0-9]+", text) if w and w not in STOPWORDS}


def form_label(name: str) -> str:
    match = re.search(r"\((.*)\)\s*$", name)
    return match.group(1) if match else name


def match_score(entry: dict, costume: dict) -> int:
    """Word overlap between a gameinfo form name and a Bulbapedia costume.

    Words from the image file name (e.g. "Moon" in GO0025Moon.png) identify a single costume, so
    they count double compared to words in the shared costume name (e.g. "Sun/Moon crown").
    """
    species = tokens(entry["name"].split(" (")[0])
    mine = tokens(form_label(entry["name"])) - species
    return len(mine & (tokens(costume["form"]) - species)) + 2 * len(mine & (tokens(costume["code"]) - species))


def match_costumes(candidates: dict[int, dict], costumes: list[dict]) -> dict[int, int]:
    """Match gameinfo costume forms to Bulbapedia costumes.

    `candidates` maps gameinfo form id -> gameinfo entry. Returns gameinfo id -> index into
    `costumes`. Uses manual overrides, then repeatedly takes the strongest unambiguous word
    overlap, then pairs the last remaining unmatched form/costume of a species.
    """
    by_file = {c["file"]: i for i, c in enumerate(costumes)}
    taken: set[int] = set()
    result: dict[int, int] = {}

    for gid, file_name in MANUAL_MATCHES.items():
        if gid in candidates and file_name in by_file:
            result[gid] = by_file[file_name]
            taken.add(by_file[file_name])

    while True:
        best = None  # (score, gid, costume index)
        for gid, entry in candidates.items():
            if gid in result:
                continue
            scored = sorted(
                ((match_score(entry, c), i) for i, c in enumerate(costumes) if i not in taken and c["dex"] == entry["pokemon"]),
                reverse=True,
            )
            if not scored or scored[0][0] == 0 or (len(scored) > 1 and scored[1][0] == scored[0][0]):
                continue
            if best is None or scored[0][0] > best[0]:
                best = (scored[0][0], gid, scored[0][1])
        if best is None:
            break
        result[best[1]] = best[2]
        taken.add(best[2])

    for dex in {e["pokemon"] for e in candidates.values()}:
        left_g = [g for g, e in candidates.items() if e["pokemon"] == dex and g not in result]
        left_c = [i for i, c in enumerate(costumes) if c["dex"] == dex and i not in taken]
        if len(left_g) == 1 and len(left_c) == 1:
            result[left_g[0]] = left_c[0]
            taken.add(left_c[0])
    return result


# --------------------------------------------------------------------------- building

def is_costume_candidate(gid: int, entry: dict, listed: set[int]) -> bool:
    if gid in LISTED_COSTUME_FORMS:
        return True
    return gid not in listed and entry["pokemon"] not in FORM_VARIANT_SPECIES | HIDDEN_VARIANT_SPECIES


def flags(entry: dict) -> dict:
    out = {}
    if entry.get("shadow"):
        out["shadow"] = 1
    if entry.get("class") == "mythic" and entry["pokemon"] not in TRADEABLE_MYTHICALS:
        out["noTrade"] = 1
    if entry.get("unobtainable"):
        out["unreleased"] = 1
    return out


def clean_label(label: str, species: str) -> str:
    """Tidy Bulbapedia costume names for display next to the species name.

    "Charmander wearing Friede's goggles" -> "Friede's goggles", "Excavator Pikachu" (for Pikachu)
    -> "Excavator", "Party hat (red)" -> "Party hat – red".
    """
    cleaned = re.sub(r"^[\w'’.-]+ wearing (?:an? )?", "", label)
    cleaned = re.sub(rf"(?<=\S) {re.escape(species)}(?!\w)", "", cleaned)
    cleaned = re.sub(r"\s*\(([^)]*)\)", r" – \1", cleaned)
    cleaned = " ".join(cleaned.split())
    return cleaned or label


def costume_label(costume: dict, gi_entry: dict | None, shared_name: bool) -> str:
    if costume["file"] in FILE_LABELS:
        return FILE_LABELS[costume["file"]]
    if not shared_name:
        return clean_label(costume["form"], costume["species"])
    if gi_entry:
        return clean_label(form_label(gi_entry["name"]), costume["species"])
    words = " ".join(re.sub(r"([a-z])([A-Z0-9])", r"\1 \2", costume["code"]).split())
    return f"{clean_label(costume['form'], costume['species'])} – {words}"


def form_variant_name(entry: dict) -> str | None:
    """Display name for an Unown or Spinda form, or None for a Spinda placeholder form."""
    if entry["pokemon"] == 201 and "(" not in entry["name"]:
        return "Unown (A)"
    if entry["pokemon"] == 327:
        number = re.search(r"\((\d+)\)$", entry["name"])
        pattern = int(number.group(1)) + 1 if number else 1
        return f"Spinda (Pattern #{pattern})" if pattern <= SPINDA_PATTERNS else None
    return entry["name"]


def build(gameinfo: dict, costumes: list[dict]) -> tuple[list[dict], dict]:
    data = {int(k): v for k, v in gameinfo["data"].items()}
    links = {int(k): v for k, v in gameinfo["links"].items()}
    listed = {gid for forms in links.values() for gid in forms}

    candidates = {gid: e for gid, e in data.items() if not e.get("temp") and is_costume_candidate(gid, e, listed)}
    matches = match_costumes(candidates, costumes)
    matched_by_costume = {i: gid for gid, i in matches.items()}

    per_dex: dict[int, list[dict]] = {}

    def add(item: dict) -> None:
        per_dex.setdefault(item["dex"], []).append(item)

    for dex in sorted(links):
        forms = [g for g in links[dex] if not data[g].get("temp") and g not in candidates]
        if dex in FORM_VARIANT_SPECIES:
            forms += sorted(g for g, e in data.items() if e["pokemon"] == dex and g not in listed)
        for gid in forms:
            name = form_variant_name(data[gid]) if dex in FORM_VARIANT_SPECIES else data[gid]["name"]
            if name:
                add({"id": f"f{gid}", "dex": dex, "name": name, "gi": gid, **flags(data[gid])})

    name_counts: dict[tuple[int, str], int] = {}
    for c in costumes:
        name_counts[(c["dex"], c["form"])] = name_counts.get((c["dex"], c["form"]), 0) + 1

    for i, c in enumerate(costumes):
        gid = matched_by_costume.get(i)
        gi_entry = data[gid] if gid else None
        label = costume_label(c, gi_entry, name_counts[(c["dex"], c["form"])] > 1)
        item = {
            "id": f"c{c['dex']:04d}{c['code']}",
            "dex": c["dex"],
            "name": f"{c['species']} ({label})",
            "costume": 1,
            "img": bulba_url(c["file"]),
            "shinyImg": bulba_url(shiny_file(c["file"])),
            "note": c["note"],
        }
        if gid:
            item["gi"] = gid
        if c["evoOnly"]:
            item["evoOnly"] = 1
        extra = flags(gi_entry or data[links[c["dex"]][0]])
        extra.pop("unreleased", None)  # Bulbapedia only lists released costumes
        extra.pop("shadow", None)
        if c["shadow"] or (gi_entry and gi_entry.get("shadow")):
            extra["shadow"] = 1
        item.update(extra)
        add(item)

    # Costumes gameinfo knows about that Bulbapedia's list does not include.
    for gid, entry in sorted(candidates.items()):
        if gid not in matches:
            add({"id": f"f{gid}", "dex": entry["pokemon"], "name": entry["name"], "gi": gid, "costume": 1, **flags(entry)})

    entries = [e for dex in sorted(per_dex) for e in per_dex[dex]]
    seen, dupes = set(), set()
    for e in entries:
        (dupes if e["id"] in seen else seen).add(e["id"])
    if dupes:
        raise ValueError(f"Duplicate entry ids: {sorted(dupes)}")

    report = {
        "matched": {data[g]["name"]: costumes[i]["file"] for g, i in sorted(matches.items())},
        "unmatchedGameinfo": [data[g]["name"] for g in sorted(candidates) if g not in matches],
        "unmatchedBulbapedia": [
            f"{c['species']} ({c['form']}) {c['file']}" for i, c in enumerate(costumes) if i not in matched_by_costume
        ],
    }
    return entries, report


def write_js(entries: list[dict], gens: list, families: list[list[int]], sources: dict) -> None:
    lines = [
        "// Generated by scripts/build_dex.py - do not edit by hand.",
        "window.DEX_DATA = {",
        f"  generatedAt: {json.dumps(datetime.date.today().isoformat())},",
        f"  sources: {json.dumps(sources)},",
        f"  gens: {json.dumps(gens, ensure_ascii=False)},",
        f"  families: {json.dumps(families, separators=(',', ':'))},",
        "  entries: [",
    ]
    lines += [f"    {json.dumps(e, ensure_ascii=False)}," for e in entries]
    lines += ["  ]", "};", ""]
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text("\n".join(lines), encoding="utf-8")


def read_or_fetch(path: str | None, url: str) -> str:
    return Path(path).read_text(encoding="utf-8") if path else fetch(url)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bulbapedia-html", help="use a saved copy of the Bulbapedia page")
    parser.add_argument("--gameinfo-json", help="use a saved copy of gameinfo's pokemon.json")
    parser.add_argument("--gameinfo-home-json", help="use a saved copy of gameinfo's pokemon-home.json")
    parser.add_argument("--report", action="store_true", help="print costume matching details")
    args = parser.parse_args()

    gameinfo = parse_gameinfo(read_or_fetch(args.gameinfo_json, GAMEINFO_DATA))
    families = parse_families(parse_gameinfo(read_or_fetch(args.gameinfo_home_json, GAMEINFO_FAMILIES)))
    page, bulba_source = load_bulbapedia(args.bulbapedia_html)
    costumes = parse_event_table(page)
    entries, report = build(gameinfo, costumes)

    write_js(entries, gameinfo["dict"]["gens"], families, {"pokedex": GAMEINFO, "costumes": BULBA_PAGE})
    costume_count = sum(1 for e in entries if e.get("costume"))
    print(f"Wrote {OUT_FILE.relative_to(ROOT)}: {len(entries)} entries ({costume_count} costumes) from {bulba_source}")
    if args.report:
        sys.stdout.reconfigure(encoding="utf-8")
        print(json.dumps(report, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
