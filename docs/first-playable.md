# Wizard RTS — First Playable

*This is the buildable version of [`wizard-rts-full-design-doc.md`](wizard-rts-full-design-doc.md). That document is the vision; this one is scoped to what the engine and the art collection can actually support today, with every placeholder resolved into a decision. Where this doc and the full doc disagree, this doc wins for the first playable and the full doc wins for the long term.*

*Grounding: everything here was checked against the codebase (`src/`) and the packed art (`tools/spriteManifest.mjs`, `src/assets/sprites.ts`, `src/assets/units.ts`). Art keys like `lair.dragonCity` are real keys in the shipped atlas.*

---

## 1. What the first playable is

One island, one player-wizard, **two AI enemy wizards**, and one way to win. The player flies around a fogged map, burns down neutral garrisons with **Fireball**, claims sites with **Conversion**, builds a small economy out of towns and mines, sends autonomous armies at things, and races the AI wizards to charge the **Points of Power**.

**The two spells are the whole spellbook.** Every wizard — player and AI — has exactly Conversion and Fireball. No spell unlocks, no loot spells, no signature slots. (Decided; supersedes §2.4 of the full doc.)

The identity sentence survives intact: **armies destroy defenses; the wizard claims.**

### What already exists (do not rebuild)

| System | Where | State |
|---|---|---|
| Island terrain, erosion, detail | `src/world/`, `src/render/` | Done. 2 km island, seeded, runs in a worker. |
| Territories & capitals | `src/world/cities.ts`, `biome.ts` | Done. 15 capitals over 6 biome factions, player starts in the gentlest (Meadowlands), balanced areas. |
| Site pads, settlements, scatter | `src/world/sites.ts` | Done. Flattened pads, house rings around capitals, per-biome vegetation. |
| Fog of war | `src/world/fog.ts`, `src/game/fogOfWar.ts` | Done. Explored/visible, altitude widens sight, owned sites stay revealed, culls cards and terrain. |
| Flying avatar | `src/game/avatar.ts` | Done as a stand-in. 17 m/s, world-fixed WASD, carpet hover. |
| Camera, compass, touch HUD | `src/render/camera.ts`, `src/ui/` | Done, including phone D-pad. |
| Sprite card renderer | `src/render/cardLayer.ts` | Done for static cards. Needs an animation driver for units. |
| Creature animation atlas | `src/assets/units.png` + `units.ts` | **Packed and committed but never loaded.** 54 creatures × (Idle/Walk/Attack/Damage/Death) × 4 frames. Wiring it up is a renderer change, not an art change. |

### What the first playable adds

Units on the map, combat, the two spells, wizard HP/mana, city production, gold, site garrisons, Points of Power, the army panel, and two AI wizards. That's the list; everything else in the full doc is deferred (§8).

---

## 2. The map, recast as a game board

The generator already places 15 capitals. The first playable assigns them roles instead of generating anything new:

- **1 player capital** — the one nearest the island centre (already flagged `player: true` in `cities.ts`). Faction art: `city.castle`, castle roster.
- **2 AI wizard capitals** — the two capitals farthest from the player's, so the early game is PvE. Faction art: `city.necropolis` and `city.stronghold`, with matching rosters.
- **12 neutral towns** — everything else. Garrisoned, unaligned, convertible. They keep their biome's look; ownership is shown by a banner/tint on the card, not by swapping the sprite.

On top of the towns, world-gen sprinkles (new placement code, existing art, existing `flattenSitePads` mechanism):

- **~8 gold mines** — a `vein.gold` card guarded by a small garrison; after Conversion it swaps to `mine.gold` and pays income. One per territory-ish, placed on buildable ground away from towns.
- **~6 monster lairs** — tier-2/3 garrisons with no economy, guarding the mid-map. Art from the lair set (`lair.keep`, `lair.griffinTower`, `lair.medusaBank`, `lair.dragonCity` for the single hardest one, etc.). Reward: a one-time gold cache (`pickup.chest` on the pad until collected by flying over it).
- **5 Points of Power** — art `mod.standingStones` (fallback `mod.shrine3`). Two seeded near the player's and AI homelands (one each region), three in the contested middle guarded by the strongest lairs. Placement rule mirrors the full doc's §7.

Scale sanity: the island is 2 km across and territories are ~380 m wide. The wizard crosses the island in ~2 min; armies march at **4 m/s** (~8 min edge-to-edge, 1.5–2.5 min for a typical intra-territory march). Those ratios match the full doc's intent (wizard ≈ 4× army speed) without touching the tuned world scale.

---

## 3. The wizard

### Movement — keep what exists, defer skiing

The current avatar (17 m/s, world-fixed WASD, carpet hover, touch D-pad) **is** the first-playable wizard. Tribes-style skiing, boost charges, momentum, and the altitude band (§2.1 of the full doc) are all deferred — they're a feel feature, and the first playable is proving the loop, not the traversal. One addition only: **Shift = sprint, 1.5× speed, drains mana at 4/s.** It reuses the existing input map, gives mana a second consumer, and stands in for boost until skiing is built.

The avatar body stays the 3D carpet stand-in. There is no wizard sprite in the pack (the mage sheet is literally missing — see `spriteManifest.mjs`), and a 3D figure among sprite cards is already the established look of the game.

### Health and death

- **100 HP.** Site defenses and enemy units target the nearest hostile, wizard included.
- At 0 HP: screen fades, wizard **respawns at their nearest owned city 15 s later**. No item/progress loss; the cost is time and position (full doc §2.2, confirmed decision).
- **Regen**: +3 HP/s inside friendly territory (within `siteRadius` = 150 m of an owned site), 0 elsewhere.

### Mana

- One pool, **100 max**, +2/s base regen.
- Each owned **Shrine** building: +1/s. Each held **Point of Power**: +3/s.
- Consumers: Fireball and sprint. That's a real economy with only two spenders, and it makes shrines and points worth holding before the victory clock matters.

### The two spells

**Fireball** — the always-available attack.
- Aim: fires toward the reticle/tap point, from the wizard, as a projectile (25 m/s) that detonates on first contact or at target ground.
- **6 m damage radius, 30 damage** (units near centre die in 1–3 hits; buildings/defense towers take siege-length attrition — see combat numbers, §5).
- **Cost 15 mana, 1.5 s cooldown.** Sustainable rate ~1 cast/7 s on base regen; shrines visibly raise it.
- VFX is generated, not drawn: an emissive sphere + point light + particle puff from three.js primitives. No art dependency.

**Conversion** — the claim.
- Valid on a site whose garrison is dead (or a Point of Power/mine likewise cleared) while the wizard is within the site pad.
- **10 s channel. The wizard lands and cannot move or cast. Taking any hit interrupts** (full doc proposed 15 s + damage threshold; 10 s and any-hit is simpler and reads instantly).
- Costs no mana — its cost is vulnerability.
- On completion: site changes ownership (banner/tint), fog keeps it permanently revealed (already how `fogOfWar.ts` treats owned sites), mines start paying, cities start producing, points start charging.

AI wizards use exactly the same two spells under the same costs.

---

## 4. Cities and economy

Massively cut from the full doc's §3: **no tiers, no caravans, no connection resources, no siege, no markets, no war camps, no retinue.** What remains is one currency and one queue.

### Gold

- Every owned city: **+10 gold/min**. Every owned mine: **+15 gold/min**. Lair caches: 100–300 one-time.
- Starting gold: 150 (enough to queue the first army immediately).

### The production queue

One queue per city, one item at a time (the full doc's chunky-opportunity-cost idea, kept):

| Item | Cost | Time | Effect |
|---|---|---|---|
| **Train Army** | 100 g | 60 s | The city's army slot fills / reconstitutes (see §5). Time scales with how dead the army is: reconstituting a half-dead army takes 30 s. |
| **Fort** | 150 g | 90 s | Two defense towers on the pad (`mod.tower` cards) that shoot the nearest enemy. One purchase per city. |
| **Shrine** | 100 g | 60 s | +1 mana regen/s for the owner. Art: `mod.shrine1`. One per city. |

Neutral towns come with nothing built. Captured towns keep whatever stood (towers rebuilt by their new owner via repair — see §5).

That's the whole build menu. It creates exactly the choices the first playable needs: army now vs. economy later, and where to put the wizard while the queue runs.

---

## 5. Units and combat

### Army composition

The full doc's confirmed default, mapped onto the packed rosters:

| Slot | Count | Castle (player) | Necropolis (AI) | Stronghold (AI) |
|---|---|---|---|---|
| Foot | 3 | `swordsman` | `zombie` | `wolf_rider` |
| Ranged | 1 | `archer` | `ghost` | `centaur` |
| Fast (hunts ranged) | 1 | `cavalier` | `spider` | `harpy` |
| Flag bearer | 1 | `peasant` | `skeleton` | `goblin` |

Flag bearer is a non-combatant; if it's the last one standing the army routs home. No heroes, no artifacts, no special units in first playable.

### Garrisons (neutral defense)

Same unit vocabulary, drawn from the unused rosters so neutral reads as "wild":

- **Towns** — 4× `greatElf` mix (dwarf, hunter ×2, deer). Clearable by one healthy army, or by a patient wizard.
- **Mines** — 2–3 `elementals` (stone/fire). Soloable by the wizard with ~10 fireballs and some dodging.
- **Lairs** — 5–7 `darkBastion`/`elementals`, includes ranged. Needs an army plus wizard support; `lair.dragonCity` gets the top-end mix.
- **Points of Power** — lair-grade garrison that **respawns for the current owner** over 3 min, so points are defensible but never free to retake.

Garrisons regenerate to full over **5 min** (full doc §4.5), so failed attacks leave a window worth exploiting.

### Combat model

Deliberately dumb: every unit has HP, DPS, range, speed; targets the nearest enemy; walks (via terrain-aware straight-line steering, no pathfinding grid in v1 — the island's passes are wide and armies may take ugly routes; fix only if it actually looks broken) and attacks. Melee range 2 m, ranged 40 m. Baseline: foot 60 HP / 6 DPS, ranged 35 HP / 8 DPS, fast 45 HP / 8 DPS + 2× speed, towers 200 HP / 10 DPS / 60 m.

Rendering: animated cards from the units atlas — Walk when moving, Attack in range, Damage flash, Death then despawn. Idle otherwise. The five rows exist per creature; the driver is the new code.

### Command model

The full doc's confirmed no-micro model, whole:

- Each city supports **one army**. Trained → idles at the city → defends it (sallies to ~1.5× tower range, then returns).
- The player gives an army exactly one order: **a target site** (or Recall). It marches, kills everything on the pad, then **camps there** until retargeted — and marches home on its own once the wizard converts the site.
- Orders come from the **army panel**: right edge, sorted by distance to the wizard, one row per army — home-city name, composition pips, status verb (Idle / Marching / Fighting / Camped / Routed / Rebuilding), health bar. Click row → click map (tap-tap on touch). Targets must be inside explored fog.
- No formations, no reinforce, no waypoints.

---

## 6. Victory

Straight from the full doc §8, which was already confirmed, with one number chosen:

- 5 Points of Power. Each held point charges its owner **+1% per 12 s** (all five held = 100% in 4 min; a realistic 2–3 points = 10–20 min of contested holding).
- **100% = instant win.** No ritual, no interrupt window. Charge persists through losing a point.
- All three wizards' percentages are always on the HUD. The defense against a leader is taking their points, which the army panel + a flying wizard makes a genuine race.

Target first-playable match length: **20–30 minutes.**

---

## 7. AI wizards

The bar is "credible pressure", not "good": a scripted loop, identical rules to the player.

1. Keep the home queue busy (army → shrine → fort → army…).
2. Send idle armies at the nearest clearable target, preferring mines/towns early, points once it owns 3+ sites.
3. Fly the wizard to wherever its army just won and convert; fireball anything hostile near it; flee home under 30 HP.
4. If any wizard (including the player) passes 60% charge, retarget all armies at that wizard's points.

No difficulty settings, no personality, no cheating economy in v1.

---

## 8. Explicitly deferred (and why it's safe to defer)

| Cut | Why safe |
|---|---|
| Skiing/boost/altitude band | Movement feel; loop works with flat flight. The mana sprint holds the slot. |
| 8 further spells, spell unlocks | **Decided**: two spells total, every wizard, no unlocks. |
| Artifacts, heroes, retinue | Reward-layer depth; needs drop/carry/transform systems with no loop dependency. |
| Caravans, connection resources, roads | Mines-pay-directly replaces them for now; caravan art (`pickup.wagon`) is already packed for later. |
| Siege, city tiers, wall breaching | First playable cities die to ordinary armies; repair-vs-damage arms race needs tiers to matter. |
| Peon theater | Pure dressing. |
| Multiplayer | Single-player skirmish only; nothing here precludes it later. |
| Unit animation beyond 5 packed rows, mage sheet | Pack limitation; mage folder ships a duplicate djinn sheet, so no player-wizard sprite exists — the 3D carpet avatar stays. |

---

## 9. Build order

Each step is playable/verifiable on its own:

1. **Load the units atlas + card animation driver** — creatures standing at sites, animating Idle. (Renderer only; atlas is already committed.)
2. **Garrison placement** — towns/mines/lairs/points seeded with defenders and pads; fog already handles reveal.
3. **Wizard HP/mana + Fireball** — HUD bars, projectile, damage, unit Death anims. The island is now a shooting gallery, and it should already be fun.
4. **Conversion + ownership** — banners/tint, income tick, permanent fog reveal, mine swap (`vein.gold` → `mine.gold`).
5. **City queue + army training** — build menu, gold, towers, shrines.
6. **Army marching + combat + panel** — the command model end to end against neutral garrisons.
7. **Points of Power + charge HUD + win screen.**
8. **AI wizards** — the §7 loop, then a tuning pass on the numbers table.

Steps 1–3 are the risk retirement: they prove sprite-card combat reads well in this renderer. Everything after is systems work on proven ground.

---

## 10. Numbers appendix (first-tuning values)

All provisional, gathered here so tuning is one file edit:

| | |
|---|---|
| Wizard speed / sprint | 17 m/s / 25.5 m/s (4 mana/s) |
| Wizard HP / regen | 100 / +3 per s in friendly territory |
| Respawn | 15 s, nearest owned city |
| Mana | 100 max, +2/s base, +1/s per shrine, +3/s per point |
| Fireball | 15 mana, 1.5 s cd, 30 dmg, 6 m radius, 25 m/s projectile |
| Conversion | 10 s channel, grounded, any hit interrupts |
| Army march | 4 m/s (fast units 8 m/s in combat) |
| Foot / ranged / fast | 60 HP 6 DPS · 35 HP 8 DPS 40 m · 45 HP 8 DPS |
| Tower | 200 HP, 10 DPS, 60 m range |
| Income | city +10 g/min, mine +15 g/min, cache 100–300 g |
| Costs | army 100 g/60 s · fort 150 g/90 s · shrine 100 g/60 s |
| Garrison regen | full over 5 min; point garrisons respawn for owner over 3 min |
| Victory charge | +1%/12 s per held point, persists, 100% instant win |
