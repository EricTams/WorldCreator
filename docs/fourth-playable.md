# Wizard RTS — Fourth Playable

*The third playable filled the island to sixty-one sites and proved it with a harness. Flying over the result, the complaint was simple and correct: **there is almost nothing out there to take.** Of sixty-one sites only three kinds answered to the wizard, all ten mines wore the same sprite, and half the board — lairs and camps — could only be burned for a purse.*

*This milestone is about what a place on the map is worth holding. It doubles the board, adds two new kinds of holding, gives the wizard a reason to spend gold outside a city queue, and makes the map say what each place is and how hard it is. Where this document and [`third-playable.md`](third-playable.md) disagree, this one wins.*

*Grounding: every art key named here is a real entry in `src/assets/sprites.ts` or `src/assets/units.ts`. Every number in §7 came out of `npm run audit-placement`, `npm run check-nodes` or `npm run match`.*

---

## 1. The rule for holding anything

> **An army clears it. The wizard consecrates it — that is what makes it yours. If what it does lands on one specific city, a caravan names which city.**

Consecration is the claim, for every kind of building, with no exceptions to remember. The caravan is not a claiming mechanism and never was: it is the **assignment** mechanism, which is why a resource node is the only thing that takes one. A monument's buff is the wizard's, a mine's gold goes to the shared pool, an outpost's patrol stays at the outpost. Only a node has an effect that must pick a beneficiary.

`second-playable.md` §8 had the caravan's *arrival* write the node's ownership, which made a node the one site the wizard could not claim. Separating the two questions is what the rule buys:

- **A node you hold but have not linked is still yours** — held ground, denied, waiting for whichever city you decide should have it.
- **A different city can commission the link later**, because ownership no longer rides on the wagon.
- **Killing a wagon drops the link, not the ground.** A raider two hundred metres away can no longer undo a consecration nobody contested.

It also deletes two standing special cases rather than maintaining them:

- "An AI must never treat a node as claimable" (`third-playable.md` §8 trap 1) is moot.
- `ai.ts`'s escape for armies camped forever on ground nobody could claim is gone — replaced by the general question it was a special case of. **An army camps while there is still something here for a wizard to come and do**, and is free otherwise. That matters more at 132 sites than it did at 61: armies clear ground far faster than one wizard can follow them round it, and the old rule pinned every army to whatever it last took. A Point of Power needs two free armies or nobody goes, so charge sat at 0% in four matches out of five until this was fixed.

---

## 2. Monuments — eight realm buffs, held only

A new site kind the wizard consecrates, whose benefit lands on the **wizard** rather than on a city. Until now everything on the board paid a city or the gold pile, and the only thing addressed to the one piece the player actually controls was a Point of Power.

| Monument | Art (unused until now) | While you hold it |
|---|---|---|
| **The Temple of the Open Sky** | `mod.temple` | +3 mana a second |
| **The Standing Shrine** | `mod.shrine1/2/3` | fireball cooldown ×0.6 |
| **The Quiet Water** | `mod.oasis` | wizard health ceiling 100 → 150 |
| **The Redwood Observatory** | `misc.observatory` | 400 units of map revealed permanently |
| **The Sanctum of Order** | `mod.templeOfOrder` | you may respawn here, not only at cities |
| **The Drowned Library** | `mod.library` | respawn in 7 seconds instead of 15 |
| **The Sphinx** | `mod.sphinx` | consecrations in half the time |
| **The Wayfarers' Post** | `misc.tradingPost` | +5 g/min for **every** city you own |

Eight questions, mirroring the node table's shape: *cast more, hit more often, survive more, see more, come back closer, come back sooner, claim faster, earn more.*

- **One of each on the board.** A node's buff is per-city, so a second Mithril seam is useful; a monument's is per-wizard, so a duplicate would do nothing. That is the node table's own "duplicates do nothing" rule, arriving as a placement decision.
- **Garrisoned at ~0.72 armies, with ranged defenders** — between a node and a lair. A monument needs an army; a stand-off does not work here the way it does at a camp. The four elementals nobody else used, so bound spirits guarding a temple read as the same wild magic that holds the mines.
- **`canClaim` needed no change.** It rejects lairs and camps by name and otherwise permits anything cleared, so consecration works for free and the AI's claim filter inherits it — the payoff from `canClaim` and `canConvert` having been split.
- **Nothing you hold regrows a garrison.** Only a Point of Power does, and it is now the sole exception. This is the rule, not an omission: defence is something you buy and station (§3), and a monument that re-garrisoned itself for free would make the outpost next door pointless.
- **Read through a live query**, `Sim.holds`, with nothing cached — the same discipline `linkedTo` follows, so losing a monument drops its buff on the next tick with no stored state to forget.

Two hooks were more than one line. **`wizardCaps`** replaces `RULES.wizard.hp`/`.mana` as ceilings, because the Oasis and the Crystal Fissure both raise one; a missed call site silently caps a buff away. And **the fog site list had to become live** — `main.ts` was feeding it `plan.owned`, a snapshot of the player's *starting* cities taken at world build, so a town captured in minute twenty lit nothing and one lost lit the map forever.

---

## 3. Outposts — buy a patrol, and it walks

Fourteen outposts of six kinds. Cleared by an army and consecrated like anything else; once held, its panel offers one purchase — **the patrol this building knows how to raise**.

| Art | Outpost | Patrol | Answers |
|---|---|---|---|
| `mod.fort` | The Watchfort | 2× Gargoyle + Naga | the solid default line |
| `mod.arena` | The Arena | 1× Titan | one expensive heavy hitter |
| `misc.tavern` | The Wayhouse | 3× Gremlin | cheapest — kills wagons, loses to armies |
| `misc.blackMarket` | The Black Market | 2× Manticore | fast raiders that run down stragglers |
| `mine.dwarvenWarren` | The Dwarven Warren | 3× Dwarf | armoured, slow, hard to shift |
| `mod.templeOfNature` | The Wardens' Post | Djinn + Pixie | reach, with something quick in front |

**What guards it is what it sells**, so the player learns each building by fighting it once. All six come from the `wizards` roster and the Great Elf leftovers, which no faction fields — a hired thing must not read as a raised thing, the same rule `GRAVEYARD_MONSTER` follows.

It was cheap to build because `site.defenders` already models *units bound to a place that fight what comes near, with a leash*. A patrol is those defenders owned by a wizard instead of by nobody, and **walking a circuit instead of standing still**. The only new behaviour is that the anchor moves; chasing, breaking off and coming back are the leash doing exactly what it already did. It is deliberately not an `Army`: no home city, no entry in the army list, no orders, so nothing about commanding armies has to learn it exists.

- **A patrol that dies is gone.** Replacing it is a fresh purchase, which makes an outpost a running cost rather than a fortification bought once.
- **A neutral outpost's garrison does not walk**, so the player meets the building before they meet the beat.
- **`markHotSites` wakes an outpost from `NEAR + beat`**, not `NEAR`. Without it a wagon walks straight through a patrol's path while the patrol is asleep — the same failure the wagon check was written for in the first place.
- Priced off `groupPower`, so the six are comparable by the measure the garrison tables are already written in.

---

## 4. Four more nodes, and ten kinds

`ResourceKind` goes from six to ten; the board carries three of each.

| Node | Art | Buff on the linked city |
|---|---|---|
| **Crystal Fissure** | `vein.crystal` → `mine.crystal` | +25 wizard max mana — **needs a Shrine**, like the Ley Spring |
| **Gem Pit** | `vein.gem` → `mine.gem` | army units ×1.3 HP — Mithril's mirror |
| **Sulfur Vent** | `vein.sulfur` → `mine.sulfur` | the **ranged** unit ×1.5 damage |
| **Quicksilver Spring** | `vein.mercury` → `mine.alchemist` | build times ×0.75 |

Gem and Sulfur **clone the archetype** through `rosterUnit`, never mutate it — `FACTIONS[n].roster.foot` is one object shared by every army that faction ever fields, so writing to it would hand the buff to every wizard on the map. The clones are cached per (city, unit, links) rather than made fresh, because reconstitution decides whether a survivor keeps its slot by comparing `def` identity, and a new object each call would silently rebuild every army on every reconstitute.

Ten kinds answer ten questions: *hit harder, arrive sooner, come back cheaper, cast more, besiege cheaper, field more, cast bigger, survive longer, shoot harder, build faster.*

---

## 5. The board: 61 → 132 sites

### The island was never full — the spacing rule was

`third-playable.md` §3 records the island as "full" at sixty-one. That claim is about the placer failing its own spacing constraints, **not about a shortage of ground**, and the two got conflated. `clear` took the *larger* of any two gaps, so a capital pushed at 150 forbade every later site within 150 — a mine, a camp, anything. Fifteen capitals sterilise about π × 150² × 15 ≈ **1.06 million square units**, against a buildable set measured at **1.66 million**. The reserves alone were very nearly the whole island.

So one number was doing two unrelated jobs, and they split:

- **Within-kind spread** — how far apart *these* things want to be. Cities still keep 150 from each other, unchanged.
- **Universal keep-out** — `radiusA + radiusB + 8`. Geometry, not taste: `radius` is the defender leash, so two sites closer than the sum of theirs are fought by both garrisons at once and the star rating on either plate becomes a lie. It never relaxes, unlike a spread.

The sum and not the larger of the two. Taking the larger reads as sensible and is not — a camp 45 units from a city clears `max(48, 24) + 12` and still stands *inside* the city's 48-unit leash. Measured over twenty seeds, that version put the closest pair of sites 45 units apart.

### Clearings were sized to the leash, not the building

Cities already derived their terrace from their art — `capitalClearing()` returns 17.6 units for a 10-unit-wide card. **Every other site borrowed `s.radius` instead**, which is the leash. A 32×32 sprite is **five world units wide**, so a lair was levelling a 40-unit disc and grading a skirt out to 80: a 160-unit scar for a building the size of a cart, and most of why the island read as bare. `siteClearing(sprite)` takes a lair from 40 to about 9, and its skirt from 80 to 18. `s.radius` is untouched, so no combat geometry moved and §2's checked camp stand-off still holds.

### The Points of Power make an X

The five points are now sited **before the capitals**, from the terrain alone: four arms on a seed-spun square at 0.55 of the half-extent, plus the middle.

A point used to be placed 45% of the way from a capital toward the centre, so the ground the match is won on was a by-product of wherever city placement dropped three towns — and a wizard who drew a roomy start drew an easy victory condition with it. The X is symmetric by construction. Measured, the four arms land at **identical radius on most seeds**.

Cities are then told where the points went (`CityParams.reserved`, marked into the one `score` grid every city-placement stage reads, so blocking a cell blocks it everywhere). Capitals are chosen as the city whose **opening run best matches the player's** — distance to the nearest point of any kind, which is what a wizard actually races. Matching distance-to-*arm* instead was tried and made it worse, 77 → 243.

Cities and points also stopped sharing a spread group: fifteen capitals holding 150 apiece inside it cost a Point of Power on a third of all seeds, and `nearest` answered a crowded ring by placing nothing at all. `nearest` now relaxes its spread and then widens its search rather than returning null — it was the last placement pass that could silently come up short.

### The mix varies, not just the positions

`NODES` and `LAIR_SPRITES` were fixed lists, so every match carried identical content merely rearranged — the map moved, the game did not. Nodes, lairs, monuments and outposts now draw their kinds and counts from a seeded roster. Every node kind still appears at least once; beyond that a seed can hand you three Quicksilver Springs and no Mithril.

The region bands are gone with them. Lairs were confined to a midland annulus and camps to within 340 of a town; a band is a guarantee about where content is, and the same guarantee on every seed is what made one match feel like the last. What the camp band protected — that the opening has something to do — is now protected by *count*: twenty-five camps at a 70-unit spread put several within a short flight of any capital on every seed.

---

## 6. Reading the board

### Name plates and the star rating

Every explored site within 420 units of the wizard carries a plate: its name and, where anything defends it, a **one-to-five star** rating. This is the full doc's §4.5 relative-strength indicator, made ambient instead of appearing only at target time.

**The count says what the place is. The colour says what is left of it.**

| | Threshold | What lands there |
|---|---|---|
| ★ | ≤ 0.25 armies | Camp 0.16 · Mine 0.15 |
| ★★ | ≤ 0.60 | Town 0.35 · Node 0.53 |
| ★★★ | ≤ 1.00 | Monument 0.72 · Lair 0.81 |
| ★★★★ | ≤ 1.80 | Point of Power 1.21 |
| ★★★★★ | > 1.80 | The central point 2.49 |

The count is absolute and never moves, so a lair reads ★★★ in minute two and in minute fifty and the player learns what a lair costs. The colour lerps gold to black with the garrison's health, so a failed assault visibly dents a plate and the five-minute regrowth restores it. **A cleared site keeps its full count in black** — *empty, and it was the hard one* says more than hiding the stars would.

- The rating is the site's own defences, **never a visiting army**. Armies move, and a rating that flickers as one walks past is worse than none.
- `starsFor` lives beside `groupPower` in `factions.ts`, not in the UI, and `npm run check-nodes` asserts every garrison's band. A wrong star is worse than no star: it is the game telling the player something false about what they are about to fly into.
- DOM overlay, pooled, culled by explored and by range. The camera is read and never touched.

### The panel explains the site

`refreshCity` showed a panel for one thing only — a city you already owned — so everything else answered with a single line of prompt text. It becomes `refreshSite`, with a branch per kind. The node branch is where **the caravan requirement is stated at the place it applies**, and it is the only place in the game that names what a node actually does:

> *Yours, but idle. Send a **caravan** from one of your cities to choose which one gets a tougher army.*

A lair now says plainly that nobody can hold it, which is the confusion behind first-playable trap #3 and was previously invisible. An outpost carries its hire button, priced, with `buildBlocked`-style refusal text as the label.

---

## 7. The tools, and the numbers

### `npm run audit-placement` — did the board actually get built?

New. `spread` fails silently by design, and a seed that fits sixteen of twenty-five camps produces a map that looks exactly like a map. It plans the real board on N seeds through the same `planGameMap` the renderer calls, asserts every count against `expectedSiteCounts` — the generator's own numbers, not a copy — and reports spacing. Exits non-zero on a shortfall.

`tools/board.ts` is new alongside it: the one correct headless world-build sequence, shared by all four tools. A tool that plans its own board is a tool that can disagree with the game, and a measurement that disagrees with the game is worse than no measurement.

`tools/biomeAudit.ts` was the proof of that. It had been **broken outright** — it omitted erosion, amplification and the coastal shelf, so every height query came back under sea level, `placeCities` returned an empty list, and it crashed on the first territory it tried to name. It also hardcoded a 60-unit capital clearing when the real figure is 17.6. It had been reporting on a board the game does not build, and then on no board at all. Fixed and run: **max/min 3.0×**, **same-faction borders 0**, **largest blob 10%** — all three inside the thresholds that file documents, so the density pass left the territories alone.

| | Third playable | Now |
|---|---|---|
| Sites on the board | 61 | **132** |
| Buildable area measured | — | **1,658k u²** average |
| Median nearest neighbour | ~170 (derived) | **86** — 5.1 s of flight at cruise |
| Closest pair of sites | — | **60**, and leashes never overlap |
| Minimum city-to-city | ~150 | **192** on the worst seed |
| X arm spread | n/a | **0 on most seeds** |
| Opening fairness | n/a | **55** median, 112 worst |
| Seeds placing the whole board | — | **30 of 30** |

### `npm run check-nodes` — 57 assertions, up from 14

Every monument buff fires *and* stops when the site changes hands; every node buff, including that Gem and Sulfur clone rather than mutate; that a node cannot be linked until consecrated and keeps its owner when its wagon dies; that each outpost sells what guarded it, once, and that its patrol walks and never regrows free; that every garrison lands in its intended star band.

### `npm run match`

Reports monuments and outposts held and patrols standing, so a whole family of sites that never enters a match is visible. **Match length is deliberately not tuned here** — `third-playable.md` §7 defers it and this milestone keeps that deferral.

---

## 8. Bugs not to introduce

Successors to `third-playable.md` §8's six, which all remain live.

1. **A monument's buff must be a live query.** Cache it anywhere and losing the site leaves the benefit running. `holds()` reads the site list every time for exactly this reason.
2. **Every ceiling must go through `wizardCaps`.** A literal `RULES.wizard.hp` left anywhere silently clamps the Oasis away, which looks identical to the Oasis not working.
3. **A buffed unit is a cached clone, never a fresh one and never the archetype.** A fresh clone every call breaks reconstitution's `def` identity comparison and rebuilds every army every time; the archetype hands the buff to every wizard on the map.
4. **A patrol is not an `Army`.** The moment it appears in the army list it competes for orders, and "fully autonomous, fixed beat" stops being true.
5. **Anything that wakes a garrison must wake it for the *patrol's* position, not the site's.** A beat is a hundred units wide; `NEAR` alone leaves every road safe by accident.
6. **A star rating must come from the site, not from what is standing on it.** The one exception is a bought patrol, which *is* the site's garrison.
7. **Placement passes must never return silently short.** `spread` closes its spacing; `nearest` now does too. `npm run audit-placement` is what catches the next one.
8. **Cities and Points of Power must not share a spread group.** Fifteen capitals at 150 apiece inside it cost a point on a third of all seeds.

---

## 9. Explicitly deferred

| Cut | Why safe |
|---|---|
| **Match-length tuning** | Unchanged from `third-playable.md` §7. Reported by the harness, not chased. |
| **AI expansion on flat seeds** | Two or three seeds in five still end with wizards on a handful of sites and no charge. It is a pre-existing weakness — measured at both 61 and 132 sites, and *better* at 132 — and it wants a milestone about the AI rather than a patch inside one about content. |
| **Mine art variety** | Six unused `mine.*`/`vein.*` pairs are still dormant; mines all still draw as gold. Considered and declined during planning. |
| **A tier-2 "Holds" tier** | The full doc's §5 middle rung. Outposts and monuments now occupy that difficulty band with more to say. |
| **Drawing site sprites larger** | Considered and declined. Name plates carry legibility at distance instead. |
| Tier-3 lair rewards, roads, the tier-3 capstone, siege against buildings, a second army per city, peon theatre | Unchanged from `third-playable.md` §7. |
