import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import build_dex  # noqa: E402


def link(species, src):
    return f'<a href="/wiki/{species}_(GO)" title="{species}"><img alt="{species}" src="{src}"></a>'


THUMB = "https://archives.bulbagarden.net/media/upload/thumb/x/xx/{0}/80px-{0}"

EVENT_PAGE = f"""
<h2><span id="List_of_Event_Pok.C3.A9mon">List of Event Pokémon</span></h2>
<table>
<tr><th>Form</th><th>Pokémon</th><th>Evolution only</th><th>Availability</th></tr>
<tr><td rowspan="2">Witch hat</td>
  <td>{link("Pikachu", THUMB.format("GO0025Halloween2017.png"))}</td>
  <td>{link("Raichu", THUMB.format("GO0026Halloween2017.png"))}</td>
  <td><ul><li>Halloween 2017: October 20 - November 2, 2017<ul><li>Male only</li></ul></li></ul></td></tr>
<tr>
  <td>{link("Teddiursa", THUMB.format("GO0216Halloween.png"))}</td><td></td>
  <td><ul><li>GO Pass - Halloween 2025</li></ul></td></tr>
<tr><td>Spooky Festival</td>
  <td>{link("Vulpix", THUMB.format("GO0037Halloween2022.png"))}{link("Shadow", THUMB.format("GO_Shadow_icon.png"))}</td>
  <td></td><td><ul><li>Halloween 2022</li></ul></td></tr>
<tr><td>PokéXciting!</td>
  <td>{link("Pikachu", THUMB.format("GO0025.png"))}</td><td></td><td>To be announced</td></tr>
</table>
<h2><span id="Trivia">Trivia</span></h2>
"""


def gi_entry(name, dex, **extra):
    return dict({"name": name, "pokemon": dex, "temp": False}, **extra)


class ParseEventTableTest(unittest.TestCase):
    def test_parses_rowspan_rows_shadow_markers_and_skips_placeholders(self):
        costumes = build_dex.parse_event_table(EVENT_PAGE)

        self.assertEqual(
            [(c["file"], c["form"], c["evoOnly"], c["shadow"]) for c in costumes],
            [
                ("GO0025Halloween2017.png", "Witch hat", False, False),
                ("GO0026Halloween2017.png", "Witch hat", True, False),
                ("GO0216Halloween.png", "Witch hat", False, False),
                ("GO0037Halloween2022.png", "Spooky Festival", False, True),
            ],
        )
        self.assertEqual(costumes[0]["note"], "Halloween 2017: October 20 - November 2, 2017")
        self.assertEqual(costumes[2]["dex"], 216)

    def test_bulbagarden_urls_use_md5_directories(self):
        self.assertEqual(
            build_dex.bulba_url("GO0172Holiday2016.png"),
            "https://archives.bulbagarden.net/media/upload/thumb/7/7b/GO0172Holiday2016.png/120px-GO0172Holiday2016.png",
        )
        self.assertEqual(build_dex.shiny_file("GO0172Holiday2016.png"), "GO0172Holiday2016_s.png")


class MatchCostumesTest(unittest.TestCase):
    def costume(self, dex, form, code):
        return {"dex": dex, "form": form, "code": code, "file": f"GO{dex:04d}{code}.png"}

    def test_file_words_break_ties_and_strongest_match_wins(self):
        costumes = [
            self.costume(25, "Sun/Moon crown", "Sun"),
            self.costume(25, "Sun/Moon crown", "Moon"),
            self.costume(25, "Flying Pikachu", "FlyRed"),
            self.costume(25, "Red's hat", "Red"),
        ]
        candidates = {
            1: gi_entry("Pikachu (Moon Crown)", 25),
            2: gi_entry("Pikachu (Sun Crown)", 25),
            3: gi_entry("Pikachu (Red Balloons)", 25),
            4: gi_entry("Pikachu (Red’s Hat)", 25),
        }

        self.assertEqual(build_dex.match_costumes(candidates, costumes), {1: 1, 2: 0, 3: 2, 4: 3})

    def test_pairs_last_unmatched_costume_of_a_species(self):
        costumes = [self.costume(41, "Top hat", "TopHat")]
        candidates = {9: gi_entry("Zubat (Halloween 2026)", 41)}

        self.assertEqual(build_dex.match_costumes(candidates, costumes), {9: 0})


class CleanLabelTest(unittest.TestCase):
    def test_removes_redundant_species_words(self):
        self.assertEqual(build_dex.clean_label("Charmander wearing Friede's goggles", "Charmeleon"), "Friede's goggles")
        self.assertEqual(build_dex.clean_label("Excavator Pikachu", "Pikachu"), "Excavator")
        self.assertEqual(build_dex.clean_label("Squirtle Squad sunglasses", "Squirtle"), "Squirtle Squad sunglasses")
        self.assertEqual(build_dex.clean_label("Party hat (red)", "Bulbasaur"), "Party hat – red")


class ParseFamiliesTest(unittest.TestCase):
    def test_reads_guarded_json_and_flattens_branching_stages(self):
        text = (';for(;;);[[{"265":[3,"wurmple",1,600,"Wurmple"]},'
                '{"266":[3,"silcoon",1,601,"Silcoon"],"268":[3,"cascoon",1,602,"Cascoon"]}],'
                '[{"52":[8,"meowth",1,64,"Galarian Meowth"]},{"863":[8,"perrserker",1,700,"Perrserker"]}]];')

        families = build_dex.parse_families(build_dex.parse_gameinfo(text))

        self.assertEqual(families, [[265, 266, 268], [52, 863]])


class BuildTest(unittest.TestCase):
    def test_merges_gameinfo_costumes_and_excludes_megas(self):
        gameinfo = {
            "data": {
                "87": gi_entry("Bulbasaur", 1, shadow=True),
                "301": gi_entry("Bulbasaur (Shedinja Costume)", 1),
                "93": gi_entry("Venusaur", 3),
                "436": gi_entry("Mega Venusaur", 3, temp=True),
                "151": gi_entry("Mew", 151, **{"class": "mythic"}),
                "999": gi_entry("Bulbasaur (Future Hat)", 1),
            },
            "links": {"1": [87], "3": [93, 436], "151": [151]},
        }
        costumes = [{
            "dex": 1, "species": "Bulbasaur", "form": "Shedinja Costume", "file": "GO0001Fall2019.png",
            "code": "Fall2019", "evoOnly": False, "shadow": False, "note": "Halloween 2019",
        }]

        entries, report = build_dex.build(gameinfo, costumes)

        by_id = {e["id"]: e for e in entries}
        self.assertEqual(list(by_id), ["f87", "c0001Fall2019", "f999", "f93", "f151"])
        self.assertEqual(by_id["c0001Fall2019"]["gi"], 301)
        self.assertEqual(by_id["c0001Fall2019"]["name"], "Bulbasaur (Shedinja Costume)")
        self.assertNotIn("shadow", by_id["c0001Fall2019"])
        self.assertEqual(by_id["f999"]["costume"], 1)
        self.assertEqual(by_id["f151"]["noTrade"], 1)
        self.assertEqual(report["unmatchedGameinfo"], ["Bulbasaur (Future Hat)"])


if __name__ == "__main__":
    unittest.main()
