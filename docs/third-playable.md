# Wizard RTS — Third Playable

*The second playable built the map game: cities that grow, nodes worth connecting, forts that need siege to crack. All of it works when a human is steering. Left to itself, almost none of it happened — and until this milestone nobody could prove that, because the harness that made the claim had been thrown away.*

*This document is the next milestone, and it is scoped to one thing: **fill out the world, and measure it**. It builds an unattended-match harness into the tree, adds the neutral content the island was missing, and fixes the AI that the harness immediately caught doing nothing. Where this doc and [`second-playable.md`](second-playable.md) disagree, this one wins for the third playable; the same relationship that doc has to [`first-playable.md`](first-playable.md).*

*It also absorbs second-playable step 7, which was never done. That step said the retune "should be made against the real generated island, not against the flat test board" and "wants a playtest rather than a harness." Half of that was right: it wanted the real island. It also wanted a harness — the one below — because the problem turned out not to be the numbers at all.*

*Grounding: every art key named here is a real entry in `src/assets/sprites.ts` or `src/assets/units.ts`, checked before it was written down. Every number in §1 and §10 came out of `npm run match` or `npm run check-nodes`.*

---

## 1. What the third playable adds

Four strands, and the first one is what justifies the other three:

1. **`npm run match` — unattended matches, in the tree.** The shipped simulation, on the real generated island, with no renderer and no human.
2. **The island gets fuller.** A new tier-1 site kind (**camps**), half again as many lairs, more mines, twice the resource nodes. 40 sites becomes 61.
3. **The three deferred node kinds land.** Ley Spring, Ironwood Grove and Monster Graveyard were cut from the second playable because each "rides a system that is deferred or brand new". Those systems shipped; the rent is now payable.
4. **The AI stops beating itself.** The harness found five separate reasons unattended matches were degenerate. None of them was the one the second playable guessed.

### What the harness found

Before a line of content was added, five seeds ran to the cap. This is the number `second-playable.md` §10 asked for and could not produce:

| | Baseline (40 sites) | Now (61 sites) |
|---|---|---|
| Wizards that ever reached tier 3 | **1 of 15** — earliest 35:10 | **14 of 30** — earliest **11:26** |
| Matches where a trebuchet was fielded | **0 of 5** | **4 of 10** |
| How matches were decided | **5 of 5 runaways** — winner on 7–14 sites, losers on 1–2 | contested; wizards trade points and cities |

The second playable guessed the cause: the AI "pays for an army, a shrine, a market and a fort at *every* city it takes before it tiers any of them up, so 400 gold for a City never comes free." That is a pacing story, and it implies a pricing fix.

It was wrong, and the harness took four minutes to say so. **Two of the three wizards never built a single army for the entire match.** Not a slow army — none, ever. What followed was five bugs in a row, each hidden behind the last, and only the fifth was about a price:

1. **The wish list spent under itself.** `queueBuild` refuses what a city cannot afford, and the AI's build ladder is written as a wish list that is *allowed to fail* — both correct alone. But the caravan step runs after the list, and a Caravan is 50 g against an army's 100 g. A capital sitting on 95 gold was refused its army and then successfully bought a caravan with the same money, forever. The queue was always busy; it was busy with the cheapest thing on it.
2. **Wizards stole each other's houses.** A capital carries no garrison by design, and the AI marches its army out the moment it has one — so a capital was *cleared*, and a cleared city can be consecrated by anyone who reaches it. Worse, capture destroys the queue and the army being paid for, so neither wizard could ever raise the garrison that would have stopped it. On some seeds two wizards simply traded capitals for thirty minutes.
3. **And they started as neighbours.** The two AI capitals were chosen for being furthest from the *player's*, which says nothing about their distance from each other. Some seeds started two wizards half a minute's flying apart.
4. **Armies died one at a time at the Points of Power.** A point is guarded at ~1.2 armies and the central one at ~2.5, and the AI sent each army at whatever was nearest *it*. Wizards sat on three cities at 0% charge for an hour, attacking points the whole time, one army at a time, losing every time.
5. **The Siege Works had nobody to give an engine to.** A trebuchet attaches only to troops standing at home and idle. Four matches in five raised a Siege Works and not one fielded an engine, because the army was always somewhere else — and simply declining to send it out was not enough, because it was already parked on a node it had cleared.

**This is what the milestone is for.** A cheaper tier 3 would not have touched any of the first four. The lesson the harness exists to enforce: *a balance claim about an unattended match is not evidence unless something ran the match.*

Match length is not being tuned here. It is reported by `npm run match` and left for a milestone that is about pacing.

---

## 2. Camps

The island had nothing for a wizard to do in the first eight minutes except escort an army. A camp is the full doc's §5 tier-1 site, and it fills exactly that hole.

| | |
|---|---|
| Count | **10**, biased to the homelands |
| Garrison | 3 × Imp — 40 HP / 4 DPS each, **melee only** (1,440 power ≈ **0.16 armies**) |
| Reward | One-time cache of **50–150 g** |
| Claimable | **No.** A camp is burned, not consecrated |
| Art | `mod.mercenaryCamp`, pad radius 24 |

- **Mechanically a mini-lair**, which is why it cost almost nothing: the cache-drop path already existed, written as `site.kind === 'lair'` in two places. It now reads "any site carrying a cache", which is what it always meant.
- **Placed near capitals**, within 340 units of a city at a 100-unit gap. Capitals reserve 150, so a camp lands in a ring around its town — close enough to be your problem, never close enough to sit in the plaza.
- **The garrison regrows on the standard five-minute rule**, so a camp is a slow renewable trickle rather than a one-time pickup. Anyone can farm it, including an AI.

### Camps and the wizard in the air

Combat distance in this game is horizontal — a unit that reaches you at 2 metres reaches you whether you stand on the ground or hover eight metres over it. So "melee only" does not by itself make a camp safe to solo from the air. The geometry does, and it is checked rather than asserted (`npm run check-nodes`):

> A camp's defenders may operate to 0.8 of the 24-unit pad — **19.2 units** from the centre. The wizard stands at **28**, reaches **15**, and is therefore **8.8 units** clear of anything that can touch it.

- **Stand-off, not immunity.** The AI flies to the pad edge and throws from there; the player learns it in one camp.
- *Rejected:* making airborne wizards immune to melee. It sounds cleaner and it is a far bigger change — it would rewrite every lair assault, every Point of Power fight and every wizard duel on the map, to fix something a metre of distance already fixes.

---

## 3. The island gets fuller

| | Was | Now | Why |
|---|---|---|---|
| Lairs | 6 | **9** | Three real sprites were sitting unused: `lair.ruins`, `lair.daemonCave`, `lair.dwarfFortress`. The midland band widens from 0.18–0.68 to 0.15–0.72 of half-extent so nine fit. |
| Mines | 8 | **10** | Mines are the homeland income that funds the tier ladder — the most direct answer to "tier 3 never comes free" that is not a price cut. |
| Resource nodes | 6 | **12** | Two each of six kinds — §4. |
| Camps | 0 | **10** | §2. |
| **Total sites** | **40** | **61** | |

Unchanged: island size, 15 capitals, 5 Points of Power. The territory layout is tuned and verified by `npm run audit-biomes`; this milestone adds density, not area. A bigger island is a different milestone with a different set of risks.

### The island turned out to be full

Sixty-one sites do not fit where forty did, and finding that out took three tries — all three worth recording, because the failure is *silent*. A map missing four of its ten mines still looks like a map.

1. **Placement order is a priority order.** Camps were placed last and landed one in ten — none at all on some seeds — because the mines had already taken the homeland ground camps are restricted to. Whatever has the least choice picks first, which is the rule the Points of Power already get. Camps now go before mines, and the shortfall moved to the mines instead.
2. **`spread` gave up silently.** It walked the candidate list once and returned however many it managed. It now retries at 85% spacing, repeatedly, down to a floor — because the *count* is a design decision and the gap is only a preference, and having those backwards is what made the first failure invisible.
3. **The real constraint was the capitals.** `clear` takes the larger of any two gaps, so fifteen capitals each reserving 170 units sterilised most of the habitable island for everything placed after them; retrying a mine at 98 units is irrelevant when a capital 160 away vetoes it regardless. **Dropping the capital reserve from 170 to 150 is the single change that made this milestone's content fit** — every seed tested now places all 61 sites, where at 170 the crowded ones managed 47. It is still three times a capital's 48-unit pad.

---

## 4. The three deferred nodes

`second-playable.md` §9 cut these with a specific reason: "Each rides a system that is deferred or brand new." Shrines, siege and the seventh formation slot are none of those things any more.

| Node | Buff on the linked city | Art |
|---|---|---|
| **Ley Spring** | This city's Shrine gives **×2 mana regen** — +2/s instead of +1/s | `mod.fairyRing` |
| **Ironwood Grove** | Trebuchets cost **×0.6** (200 → 120 g) and have **×1.5 HP** (80 → 120) | `vein.wood` → `mine.sawmill` when linked |
| **Monster Graveyard** | This city's army fields a **seventh unit**: a Golem, 180 HP / 16 DPS | `lair.cityOfTheDead` |

Six kinds now answer six questions — *hit harder, arrive sooner, come back cheaper, cast more, besiege cheaper, field more* — under the same rules as before: binary while the link is live, different kinds stack, duplicates do nothing.

**Ley Spring requires a Shrine to do anything**, deliberately. It is the first node worth nothing on its own, which makes it the first node whose value depends on what you have already built — and it quietly rewards the AI's habit of putting a shrine in everything.

**Ironwood is the anti-pacing node.** If siege is the thing unattended matches never reach, a node whose entire purpose is making siege cheaper and sturdier belongs on the board.

**Monster Graveyard half-opens a deferred door**, and that is worth being honest about. Special units are still deferred; this is not a special-unit *system*, it is one conditional entry in a roster, which is the shape the trebuchet already proved works. The Golem comes from the unused `wizards` roster so that a wild thing never reads as a faction's own troops.

Two rules the Graveyard needed, both now checked:

- **The monster arrives with the wagon, not with the next funeral.** The roster is only rebuilt on reconstitution, so the first implementation gave you nothing until your army had been mauled badly enough to be worth rebuilding — a connection you paid for that visibly did nothing. It now joins the moment the caravan lands, like every other link.
- **Cutting the link does not vaporize it.** The Golem stays with the army it is in and is simply not raised again. Retiring a live unit out from under a marching army because a wagon died two hundred metres away would be the least legible rule in the game.

---

## 5. The AI

Everything in §1's list of five, plus the pacing change the second playable actually asked for. The AI still plays by identical rules: same two spells, same costs, same queue, no vision cheat, every move through the public commands the HUD calls.

**1. Save for the top of the list instead of spending under it.** A wish that is merely unaffordable now *stops* the list. A wish that is impossible here — a trebuchet with no Siege Works — is skipped, or the city would save forever for something it can never buy. The caravan step is additionally refused to any city that has not yet raised its army.

Blocking caravans while merely *saving* was tried and reverted: a capital saving for a tier-up is saving for minutes, and refusing a 50-gold caravan for all of it left armies camped on nodes they had already cleared, waiting for a wagon nobody had commissioned.

**2. The capital grows; the villages hold.**

- **At the capital:** army → **fort** → tier → tier → Siege Works → trebuchet → market.
- **At everything else:** army → shrine → market. Fort and tier-up only once the capital has reached City.
- **Everywhere:** reinforce first if the army is below two-thirds strength. This exception is load-bearing now the list saves rather than falling through — without it a capital saving for a tier-up watches its only army get chewed down to two soldiers and keeps saving.

Walls come first at the capital and nowhere else. It is the one city that must not fall, and it is the answer to §1's capital-stealing: **towers do not march away.**

**3. Every wizard opens with its army already standing at home.** Not a gift — it is the army each would spend their first hundred gold and first sixty seconds on anyway — but it closes the opening minute in which a capital has literally nothing standing in it.

**4. Two armies go at a Point of Power together, or neither goes.** Concentration of force is the one piece of generalship this AI needs, because a point is the only objective on the map a single city's army cannot take.

**5. An army whose city has a Siege Works is *recalled* to receive its engine.** Declining to send it out was not enough; it has to actually come home. Bounded — it ends when the trebuchet is built — and it yields to the endgame, because once somebody is about to win an engine is a luxury nobody has time for.

**6. Caravans only go as far as they are worth.** The queue is held from commission until the wagon arrives, so a node 800 units away is four and a half minutes during which that city builds nothing else — and the AI was paying that at its *capital*. Nodes beyond 450 units are left alone.

**7. Lairs and camps are no longer player-only content.** With nine lairs and ten camps on the board, an AI that ignores all of them leaves most of the map's loose gold on the floor. An army with three sites behind it will clear a nearby lair; the wizard collects the cache, and burns camps when it has nothing to claim.

**8. An army camped on a cleared node is free to be re-tasked.** Camping holds ground until the wizard consecrates it — but a node is never consecrated, so an army camped on one waits forever. Six soldiers stood on a node for half an hour while their wizard held three cities and no points.

---

## 6. The tools

### `npm run match` — unattended matches

`tools/matchHarness.ts`, following `tools/biomeAudit.ts` exactly: bundled by rolldown, run under node, no new dependencies, no browser. The board is built by the same calls `main.ts` makes in the same order, and the match is stepped by the same `Sim.update` the render loop drives, at the 0.1 s step `main.ts` already clamps to.

**The simulation gave up one flag**: `SimOptions.allAi` hands faction 0 to `flyAi` as well. That is the whole concession, and it is a flag rather than a headless variant of `Sim` for a reason — the moment the harness runs different code from the game, its numbers stop being evidence about the game.

It reports match length, winner, per-wizard tier timeline, first Siege Works, trebuchets fielded, sites held, charge and deaths; `--json` writes one row per match so a retune is a diff rather than an argument.

**Determinism is what makes it useful.** The sim reads no clock and no global RNG, so a seed names a match exactly — verified: two runs of the same seed produce byte-identical JSON.

**One honest difference from the game:** scenery-card pads are not flattened, because choosing them is a renderer job. Units move in pure XZ and ground height only reaches the wizard's hover and a projectile's impact test, so nothing measured depends on it. It is printed in the banner rather than buried in a comment.

*Rejected:* a Vite page running the real renderer at ×N speed — not scriptable, not usable from CI, and rAF throttling in a background tab makes "unattended" a lie. And vitest, which would introduce a test framework this repo has deliberately done without, for something that is a reporting tool rather than an assertion suite.

### `npm run check-nodes` — does the rule fire at all?

`tools/nodeCheck.ts` drives the shipped `Sim` through its public commands on a flat four-site board and asserts the fourteen claims §2 and §4 make: that a Ley Spring doubles a shrine and does nothing without one, that an Ironwood engine is cheaper and sturdier *and that the shared archetype was not mutated to get there*, that a Golem joins on arrival and is never duplicated and outlives its link, and that a camp's stand-off geometry actually leaves the wizard out of reach.

The two tools answer different questions and neither substitutes for the other: an unattended match can look perfectly healthy while a buff nobody happened to link does nothing whatsoever.

---

## 7. Explicitly deferred

| Cut | Why safe |
|---|---|
| **Tier-3 lair rewards — artifacts and spells** (full doc §5) | Both ride whole deferred systems: the artifact/carry model and the eight-spell book. Lairs keep paying gold, which the AI can now also collect. |
| **Watchtower holds guarding nodes** as a separate site kind | Nodes already carry a 0.53-army garrison. A second guardian adds placement pressure to an island that just proved to be full, and creates no decision the node's own garrison doesn't. |
| **Melee-vs-airborne immunity** | Rejected on the merits, not deferred for cost — §2. |
| **Match-length tuning** | Reported by the harness, not chased here. The levers that shorten a match (a faster charge race) are the same ones that cut how many wizards live long enough to build siege, so it is a trade that wants its own milestone and its own argument. |
| **Roads and the road speed bonus** | Unchanged from `second-playable.md` §9: needs a traffic heat grid and sim-driven terrain writes. |
| **Tier-3 capstone** (Champion's Hall / High Aerie) | Still needs special units and retinue. The Graveyard Golem is one unit on one condition, not the system. |
| **Siege damaging buildings other than towers** | Still needs per-building HP and a disabled state. |
| **A second army per city, a second city currency, Market gating caravan range** | Unchanged from `second-playable.md` §9, including the reasoning about expansion being the way to field more troops. |
| **Peon theater** | Still dressing. |
| Skiing, further spells, artifacts, heroes, retinue, multiplayer | Unchanged from `first-playable.md` §8. |

---

## 8. Build order — **all eight steps built**

Each step is playable on its own and typechecks on its own (`npm run typecheck`, the check CI runs).

0. **This document.**
1. **The harness** — `tools/matchHarness.ts`, the `allAi` flag, and the town-clearing derivation moved somewhere a headless tool can reach it. *Deliverable: the baseline in §1.*
2. **Camps** — the site kind, its garrison, the cache generalization, and the AI that burns them.
3. **The density pass** — lairs, mines, node count, and the placement work in §3.
4. **Ley Spring and Ironwood Grove.**
5. **Monster Graveyard.**
6. **The AI** — all eight changes in §5.
7. **Tuning pass** — one price moved; see below.

### What the build actually cost

The `allAi` flag was three lines and the harness found a match-breaking bug on its first run, which is a good trade. Four things were less tidy than expected:

**The town clearing had to be pulled out of the renderer before a headless tool could plan a board.** `main.ts` derived it from `CardLayer.spriteWidth`, and `CardLayer` imports three.js at value level. It now lives in `world/sites.ts` as `capitalClearing()`, over a shared `assets/spriteScale.ts`. This is not incidental tidying: `tools/biomeAudit.ts` had been **hardcoding 60** for this number, with a comment explaining that the atlas was a browser concern. The real value is 17.6. That audit had been planning cities on a board the game does not build.

**A cache is a property of a site, not a kind of site.** Two guards said `kind === 'lair'` where they meant "has a cache".

**Only one price moved: tier 3, from 400 gold to 300.** It is the first of three payments totalling nine hundred gold before an engine can exist, and half the wizards never made it. At 300, tier 3 is reached by fourteen wizards in thirty rather than ten, the earliest by minute eleven, and engines start appearing in matches nobody is steering. `second-playable.md` §10 offered this as one of three guesses at the pacing problem; it turned out not to *be* the problem, but it is a real part of the fix.

**Every other number in `rules.ts` is untouched**, including the charge rate. Changing it is the obvious way to shorten a match and it makes fewer wizards reach tier 3 — see the deferred table.

### Bugs not to introduce (successors to `second-playable.md` §10's eight)

All eight of those remain live. Six more, every one of them found by `npm run match`:

1. **An AI must never treat a camp as claimable.** Same shape as trap §10-1 for nodes and first-playable trap #3 for lairs: a wizard that flies to a cleared camp to consecrate it hovers there for the rest of the match.
2. **A buffed unit must be a *clone*, never a mutated archetype.** `TREBUCHET_DEF` and `GRAVEYARD_MONSTER` are shared constants; writing Ironwood's ×1.5 HP onto the def itself would give every wizard on the map a 120 HP trebuchet the moment anybody linked a Grove. `npm run check-nodes` asserts this directly.
3. **Severing a link must not retire a living unit.** The Golem stops being *raised*; it does not fall over. Reconstitution's leftover-retire loop is where this goes wrong, and it is the same loop trap §10-4 warns about for the trebuchet.
4. **A wish list that saves must have an escape.** "Cannot afford yet" and "cannot ever do here" have to be distinguished, or a city saves forever for a trebuchet it has no Siege Works for. `Sim.saving()` exists to make that one question askable.
5. **Anything that stops an army being *sent* somewhere must also decide where it *is*.** The siege-wait rule declined to re-task the army and left it parked on a distant node; the Siege Works it was waiting for stood unused for the rest of the match.
6. **A silent shortfall in `spread` is invisible from inside the game.** Any placement pass that can return fewer sites than it was asked for must either close up its spacing or say so.

---

## 9. Numbers appendix (additions to `second-playable.md` §11)

| | |
|---|---|
| Sites on the board | **61** — 15 cities · 12 nodes · 10 camps · 10 mines · 9 lairs · 5 points |
| Placement gaps | capitals 150 · points 200–220 · lairs 160 · nodes 140 · camps 100 (within 340 of a town) · mines 115 · `spread` retries at ×0.85 down to half |
| Camp | 3 × Imp, 40 HP / 4 DPS, melee · 1,440 power ≈ 0.16 armies · cache 50–150 g · not claimable · pad 24 |
| Camp stand-off | defenders reach 19.2 from centre · wizard hovers at 28 · wizard's reach 15 |
| Resource nodes | 12 — two each of Mithril / Horse / Granary / Ley Spring / Ironwood / Graveyard |
| Ley Spring | linked city's Shrine gives ×2 mana regen (needs a Shrine) |
| Ironwood Grove | trebuchet 200 → 120 g · trebuchet HP 80 → 120 |
| Monster Graveyard | +1 Golem, 180 HP / 16 DPS · joins on the wagon's arrival · kept, not re-raised, once the link is cut |
| **Tier-up** | →Town 200 g / 90 s · **→City 300 g / 120 s** (was 400) |
| AI ladder, capital | army → fort → tier → tier → Siege Works → trebuchet → market |
| AI ladder, other cities | army → shrine → market · fort and tier only after the capital reaches City |
| AI, everywhere | reinforce ahead of everything else below two-thirds army strength |
| AI caravan reach | 450 units — about 2½ minutes of held queue at the wagon's 3 m/s |
| Harness | `npm run match` · dt 0.1 s · default cap 60 min · deterministic per seed |
| Rule checks | `npm run check-nodes` · 14 assertions over the six node kinds and the camp geometry |
